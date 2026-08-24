#!/bin/bash
#
# User data for the MediaMTX ECS container instance.
#
# Tokens of the form __NAME__ are substituted by media-ec2-compute.ts before
# upload: the ECS cluster name, the region and the Elastic IP allocation ID. That
# form is used rather than ${NAME} so the tokens cannot collide with the shell's
# own parameter expansion below.
#
set -euxo pipefail

#
# Join the ECS cluster
#
cat <<EOF > /etc/ecs/ecs.config
ECS_CLUSTER=__CLUSTER_NAME__
ECS_ENABLE_CONTAINER_METADATA=true
ECS_ENABLE_SPOT_INSTANCE_DRAINING=true
# Task IAM roles are off by default for host network mode and must be opted
# into. Without this the container gets no task credentials, so EFS IAM
# authorisation fails.
# See https://repost.aws/knowledge-center/ecs-iam-task-roles-config-errors
ECS_ENABLE_TASK_IAM_ROLE=true
ECS_ENABLE_TASK_IAM_ROLE_NETWORK_HOST=true
EOF

systemctl enable --now docker
systemctl enable ecs
systemctl start --no-block ecs
echo "ECS agent start queued; ecs.service runs after cloud-final.service completes."

#
# Raise UDP socket buffer limits.
#
# MediaMTX benefits from a large UDP read buffer for WebRTC ICE and SRT. Raising
# the OS default here means it gets one without calling setsockopt(SO_RCVBUF),
# which fails hard when the kernel limit is lower than the requested size.
#
cat <<'EOF' > /etc/sysctl.d/99-media-webrtc.conf
net.core.rmem_max = 8388608
net.core.rmem_default = 4194304
net.core.wmem_max = 8388608
net.core.wmem_default = 4194304
EOF

sysctl --system || true

#
# Attach the Elastic IP.
#
# This address is only used as the WebRTC ICE candidate — client-facing DNS points
# at the load balancer, which gates traffic on its own health checks. So there is
# no need to defer association until the media API is up; attaching it eagerly
# means the address is ready before the task starts advertising it.
#
if ! command -v aws >/dev/null 2>&1; then
    if command -v dnf >/dev/null 2>&1; then
        dnf install -y awscli || true
    elif command -v yum >/dev/null 2>&1; then
        yum install -y awscli || true
    fi
fi

if ! command -v aws >/dev/null 2>&1; then
    echo "warning: awscli unavailable, cannot associate EIP; WebRTC ICE will not work"
    exit 0
fi

token=$(curl --fail --silent --show-error --request PUT \
    "http://169.254.169.254/latest/api/token" \
    --header "X-aws-ec2-metadata-token-ttl-seconds: 21600")
instance_id=$(curl --fail --silent --show-error \
    --header "X-aws-ec2-metadata-token: $token" \
    "http://169.254.169.254/latest/meta-data/instance-id")

for attempt in $(seq 1 10); do
    if aws ec2 associate-address \
        --region __AWS_REGION__ \
        --instance-id "$instance_id" \
        --allocation-id __EIP_ALLOCATION_ID__ \
        --allow-reassociation; then
        echo "Associated EIP __EIP_ALLOCATION_ID__ with $instance_id"
        exit 0
    fi

    echo "Attempt $attempt: EIP association failed, retrying"
    sleep 10
done

echo "warning: failed to associate EIP after retries"
exit 1
