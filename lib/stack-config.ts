/**
 * Configuration interface for MediaInfra stack template
 * This makes the stack reusable across different projects and environments
 */

/**
 * Context-based configuration interface matching cdk.context.json structure
 * This is used directly by the stack without complex transformations
 */
export interface ContextEnvironmentConfig {
  stackName: string;
  enableInsecurePorts: boolean;
  usePreBuiltImages: boolean;
  /**
   * MediaMTX log level. Passed to the container as LOG_LEVEL and applied to
   * mediamtx.yml at startup by the container entrypoint.
   */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /**
   * EC2 capacity provider configuration.
   *
   * The media service runs on EC2 with `host` network mode rather than Fargate
   * so that WebRTC ICE (direct UDP) works. Fargate awsvpc networking cannot
   * provide the direct UDP connectivity ICE requires.
   */
  ec2: {
    /** ARM64 (Graviton) instance type for the ECS capacity provider */
    instanceType: string;
    /** Auto Scaling Group minimum instance count */
    minCapacity: number;
    /** Auto Scaling Group maximum instance count */
    maxCapacity: number;
  };
  ecs: {
    taskCpu: number;
    taskMemory: number;
    desiredCount: number;
    enableDetailedLogging: boolean;
    enableEcsExec?: boolean;
  };
  general: {
    removalPolicy: string;
    enableDetailedLogging: boolean;
    enableContainerInsights: boolean;
  };
  ecr: {
    imageRetentionCount: number;
    scanOnPush: boolean;
  };
  docker?: {
    mediamtxImageTag?: string;
  };
  mediamtx?: {
    version: string;
    buildRevision: number;
  };
}