#!/bin/bash
#
# User data for the MediaMTX ECS container instance.
#
# Tokens of the form __NAME__ are substituted by media-ec2-compute.ts before
# upload: the ECS cluster name, the region, the Elastic IP allocation ID and the
# media API port. That form is used rather than ${NAME} so the tokens cannot
# collide with the shell's own parameter expansion below.
#
set -euxo pipefail

#
# Join the ECS cluster
#
cat <<EOF > /etc/ecs/ecs.config
ECS_CLUSTER=__CLUSTER_NAME__
ECS_ENABLE_CONTAINER_METADATA=true
ECS_ENABLE_SPOT_INSTANCE_DRAINING=true
EOF

systemctl enable --now docker
systemctl enable ecs
systemctl start --no-block ecs
echo "ECS agent start queued; ecs.service runs after cloud-final.service completes."

#
# Raise UDP socket buffer limits.
#
# MediaMTX requests a 4 MiB UDP read buffer for WebRTC ICE and SRT. The default
# kernel limits are lower than that, and setsockopt(SO_RCVBUF) fails without
# these. This is the reason the buffer size is tuned here on the host rather
# than in mediamtx.yml.
#
cat <<'EOF' > /etc/sysctl.d/99-media-webrtc.conf
net.core.rmem_max = 8388608
net.core.rmem_default = 4194304
net.core.wmem_max = 8388608
net.core.wmem_default = 4194304
EOF

sysctl --system || true

#
# Attach the Elastic IP once the media service is actually serving.
#
# DNS points at this EIP, so associating it before the container is ready would
# briefly blackhole traffic. The association is deferred to a systemd unit that
# polls the local API port first, letting cloud-init finish promptly.
#
if ! command -v aws >/dev/null 2>&1; then
    if command -v dnf >/dev/null 2>&1; then
        dnf install -y awscli || true
    elif command -v yum >/dev/null 2>&1; then
        yum install -y awscli || true
    fi
fi

if ! command -v aws >/dev/null 2>&1; then
    echo "warning: awscli unavailable, skipping EIP association"
    exit 0
fi

cat <<'EOF' > /usr/local/bin/media-eip-association.sh
#!/bin/bash
set -euo pipefail

region="$1"
allocation_id="$2"
api_port="$3"

wait_for_tcp_port() {
    timeout 1 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$1" "$2" >/dev/null 2>&1
}

token=$(curl --fail --silent --show-error --request PUT \
    "http://169.254.169.254/latest/api/token" \
    --header "X-aws-ec2-metadata-token-ttl-seconds: 21600")
instance_id=$(curl --fail --silent --show-error \
    --header "X-aws-ec2-metadata-token: $token" \
    "http://169.254.169.254/latest/meta-data/instance-id")

for attempt in $(seq 1 60); do
    if ! wait_for_tcp_port 127.0.0.1 "$api_port"; then
        echo "Attempt $attempt: waiting for media API listener on 127.0.0.1:$api_port"
        sleep 10
        continue
    fi

    if aws ec2 associate-address \
        --region "$region" \
        --instance-id "$instance_id" \
        --allocation-id "$allocation_id" \
        --allow-reassociation; then
        echo "Associated EIP $allocation_id with $instance_id"
        exit 0
    fi

    sleep 10
done

echo "warning: failed to associate EIP after retries"
exit 1
EOF

chmod 755 /usr/local/bin/media-eip-association.sh

cat <<EOF > /etc/systemd/system/media-eip-association.service
[Unit]
Description=Associate media EIP once the local media API is ready
Wants=network-online.target docker.service ecs.service
After=network-online.target docker.service ecs.service

[Service]
Type=simple
ExecStart=/usr/local/bin/media-eip-association.sh __AWS_REGION__ __EIP_ALLOCATION_ID__ __API_PORT__
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable media-eip-association.service
systemctl start --no-block media-eip-association.service
echo "EIP association queued; user-data exits while it waits for the media API port."
