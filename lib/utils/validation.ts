/**
 * Validation utilities for MediaInfra stack
 */

import { ContextEnvironmentConfig } from '../stack-config';

/**
 * Validate environment type
 */
export function validateEnvType(environment: string): void {
  const validEnvironments = ['prod', 'dev-test'];
  if (!validEnvironments.includes(environment)) {
    throw new Error(`Invalid environment type: ${environment}. Must be one of: ${validEnvironments.join(', ')}`);
  }
}

/**
 * Validate stack name
 */
export function validateStackName(stackName: string): void {
  if (!stackName || stackName.trim().length === 0) {
    throw new Error('Stack name cannot be empty');
  }
  
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(stackName)) {
    throw new Error(`Invalid stack name: ${stackName}. Must start with letter and contain only letters, numbers, and hyphens`);
  }
}

/**
 * Validate MediaMTX configuration
 */
export function validateMediaMtxConfig(config: ContextEnvironmentConfig): void {
  // Validate ECS configuration
  if (config.ecs.taskCpu <= 0) {
    throw new Error('ECS task CPU must be greater than 0');
  }
  
  if (config.ecs.taskMemory <= 0) {
    throw new Error('ECS task memory must be greater than 0');
  }
  
  if (config.ecs.desiredCount < 0) {
    throw new Error('ECS desired count cannot be negative');
  }

  // Validate EC2 capacity provider configuration
  if (!config.ec2?.instanceType) {
    throw new Error('EC2 instance type must be specified');
  }

  // The media service requires ARM64 (Graviton) instances to match the
  // container image architecture built by docker/media-infra/Dockerfile
  if (!/^[a-z]+\d+g[a-z]*\./.test(config.ec2.instanceType)) {
    throw new Error(
      `Invalid EC2 instance type: ${config.ec2.instanceType}. ` +
      'Must be an ARM64 (Graviton) instance type, e.g. t4g.large, m7g.xlarge'
    );
  }

  if (config.ec2.minCapacity < 1) {
    throw new Error('EC2 minimum capacity must be at least 1');
  }

  if (config.ec2.maxCapacity < config.ec2.minCapacity) {
    throw new Error('EC2 maximum capacity cannot be less than minimum capacity');
  }

  // The media service cannot run on more than one instance.
  //
  // A published stream lives in a single MediaMTX process with no clustering, so
  // a second instance cannot serve it. Because the NLB target groups are attached
  // to the Auto Scaling Group rather than to task placement, every extra instance
  // is registered as a target regardless of whether it runs the task, and silently
  // fails roughly half of all client connections.
  if (config.ec2.maxCapacity > 1) {
    throw new Error(
      `EC2 maximum capacity must be 1, got ${config.ec2.maxCapacity}. ` +
      'The media service is single-instance: a stream exists only on the MediaMTX ' +
      'process it was published to, and additional ASG instances are registered as ' +
      'load balancer targets without running the task, black-holing client connections.'
    );
  }

  // Validate log level if specified
  if (config.logLevel && !['debug', 'info', 'warn', 'error'].includes(config.logLevel)) {
    throw new Error(`Invalid log level: ${config.logLevel}. Must be one of: debug, info, warn, error`);
  }
  
  // Validate ECR configuration
  if (config.ecr.imageRetentionCount <= 0) {
    throw new Error('ECR image retention count must be greater than 0');
  }
  
  // Validate MediaMTX version if specified
  if (config.mediamtx?.version && !/^v?\d+\.\d+\.\d+/.test(config.mediamtx.version)) {
    throw new Error(`Invalid MediaMTX version format: ${config.mediamtx.version}`);
  }
}