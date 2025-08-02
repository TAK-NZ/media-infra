#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MediaInfraStack } from '../lib/media-infra-stack';
import { applyContextOverrides } from '../lib/utils/context-overrides';
import { DEFAULT_AWS_REGION } from '../lib/utils/constants';
import { generateStandardTags } from '../lib/utils/tag-helpers';

const app = new cdk.App();

// Get environment from context (defaults to dev-test)
const envName = app.node.tryGetContext('envType') || 'dev-test';

// Get the environment configuration from context
const envConfig = app.node.tryGetContext(envName);
const defaults = {
  project: app.node.tryGetContext('tak-project') || app.node.tryGetContext('tak-defaults')?.project,
  component: app.node.tryGetContext('tak-component') || app.node.tryGetContext('tak-defaults')?.component,
  region: app.node.tryGetContext('tak-region') || app.node.tryGetContext('tak-defaults')?.region
};

if (!envConfig) {
  throw new Error(`
❌ Environment configuration for '${envName}' not found in cdk.json

Usage:
  npx cdk deploy --context envType=dev-test
  npx cdk deploy --context envType=prod

Expected cdk.json structure:
{
  "context": {
    "dev-test": { ... },
    "prod": { ... }
  }
}
  `);
}

// Apply context overrides for command-line parameter support
const finalEnvConfig = applyContextOverrides(app, envConfig);

// Create stack name
const stackName = `TAK-${finalEnvConfig.stackName}-MediaInfra`;

// Create the stack
const stack = new MediaInfraStack(app, stackName, {
  environment: envName as 'prod' | 'dev-test',
  envConfig: finalEnvConfig,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || defaults?.region || DEFAULT_AWS_REGION,
  },
  tags: generateStandardTags(finalEnvConfig, envName as 'prod' | 'dev-test', defaults)
});