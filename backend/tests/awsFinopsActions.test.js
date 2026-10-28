/**
 * The full IAM action list behind Settings > FinOps > Data sources "Everything ICC uses":
 * poller actions plus every capability's actions, sorted and unique, one entry per SDK
 * command ICC sends.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const finops = require('../services/awsFinops');

describe('allActions', () => {
  it('covers the poller set and every capability, sorted and unique', () => {
    const all = finops.allActions();
    expect(all).toEqual([...new Set(all)].sort());
    for (const a of finops.BASE_ACTIONS) expect(all).toContain(a);
    for (const list of Object.values(finops.CAPABILITY_ACTIONS)) for (const a of list) expect(all).toContain(a);
    for (const a of ['ec2:DescribeInstances', 'cloudwatch:GetMetricData', 's3:ListAllMyBuckets', 'ce:GetCostAndUsage',
      'budgets:ViewBudget', 'pricing:GetProducts', 'cost-optimization-hub:ListRecommendations', 'savingsplans:DescribeSavingsPlans',
      'compute-optimizer:GetIdleRecommendations', 's3:GetBucketTagging', 'sts:GetCallerIdentity']) {
      expect(all).toContain(a);
    }
    expect(all.some((a) => a.includes('*'))).toBe(false);
  });
});
