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