/**
 * Mock configurations for MediaInfra testing
 */
export const mockDevConfig = {
  stackName: 'Dev',
  enableInsecurePorts: false,
  usePreBuiltImages: false,
  logLevel: 'info' as const,
  ec2: {
    instanceType: 't4g.large',
    minCapacity: 1,
    maxCapacity: 2
  },
  ecs: {
    taskCpu: 512,
    taskMemory: 1024,
    desiredCount: 1,
    enableDetailedLogging: true
  },
  general: {
    removalPolicy: 'DESTROY',
    enableDetailedLogging: true,
    enableContainerInsights: false
  },
  ecr: {
    imageRetentionCount: 5,
    scanOnPush: false
  }
};
export const mockProdConfig = {
  stackName: 'Prod',
  enableInsecurePorts: false,
  usePreBuiltImages: false,
  logLevel: 'warn' as const,
  ec2: {
    instanceType: 't4g.xlarge',
    minCapacity: 1,
    maxCapacity: 2
  },
  ecs: {
    taskCpu: 1024,
    taskMemory: 2048,
    desiredCount: 1,
    enableDetailedLogging: true
  },
  general: {
    removalPolicy: 'RETAIN',
    enableDetailedLogging: true,
    enableContainerInsights: true
  },
  ecr: {
    imageRetentionCount: 20,
    scanOnPush: true
  }
};
export const mockInvalidConfig = {
  stackName: '',
  enableInsecurePorts: false,
  usePreBuiltImages: false,
  ec2: {
    instanceType: '',
    minCapacity: 0,
    maxCapacity: 0
  },
  ecs: {
    taskCpu: 0,
    taskMemory: 0,
    desiredCount: 0,
    enableDetailedLogging: true
  },
  general: {
    removalPolicy: 'DESTROY',
    enableDetailedLogging: true,
    enableContainerInsights: false
  },
  ecr: {
    imageRetentionCount: 5,
    scanOnPush: false
  }
};
export const mockCloudFormationExports = {
  'TAK-Dev-BaseInfra-VPCId': 'vpc-12345678',
  'TAK-Dev-BaseInfra-KMSKeyArn': 'arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789012',
  'TAK-Dev-BaseInfra-PrivateSubnetIds': 'subnet-12345678,subnet-87654321',
  'TAK-Dev-BaseInfra-PublicSubnetIds': 'subnet-11111111,subnet-22222222',
  'TAK-Dev-CloudTAK-SigningSecretArn': 'arn:aws:secretsmanager:us-west-2:123456789012:secret:signing-secret-AbCdEf',
  'TAK-Dev-CloudTAK-MediaSecretArn': 'arn:aws:secretsmanager:us-west-2:123456789012:secret:media-secret-AbCdEf'
};
