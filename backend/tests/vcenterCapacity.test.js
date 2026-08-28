/**
 * Unit tests for vcenterCapacity pure math functions.
 * Tests n1Usable, rollupSite, failoverMatrix without requiring DB.
 */
import { describe, it, expect } from 'vitest';
import { n1Usable, rollupSite, failoverMatrix } from '../services/vcenterCapacity.js';

describe('n1Usable', () => {
  it('returns zero usable for single-host cluster', () => {
    const cluster = {
      hostCount: 1,
      cpuMhzCapacity: 100000,
      memBytesCapacity: 100 * 1024 * 1024 * 1024,
      cpuCores: 20,
      largestHostCpuMhz: 50000,
      largestHostMemBytes: 50 * 1024 * 1024 * 1024,
      largestHostCpuCores: 10,
    };
    const result = n1Usable(cluster);
    expect(result.cpuMhz).toBe(0);
    expect(result.memBytes).toBe(0);
    expect(result.cpuCores).toBe(0);
  });

  it('computes N+1 usable by removing largest host', () => {
    const cluster = {
      hostCount: 3,
      cpuMhzCapacity: 100000,
      memBytesCapacity: 100 * 1024 * 1024 * 1024,
      cpuCores: 60,
      largestHostCpuMhz: 40000,
      largestHostMemBytes: 40 * 1024 * 1024 * 1024,
      largestHostCpuCores: 20,
    };
    const result = n1Usable(cluster);
    expect(result.cpuMhz).toBe(60000);
    expect(result.memBytes).toBe(60 * 1024 * 1024 * 1024);
    expect(result.cpuCores).toBe(40);
  });

  it('floors negative usable to zero', () => {
    const cluster = {
      hostCount: 2,
      cpuMhzCapacity: 50000,
      memBytesCapacity: 50 * 1024 * 1024 * 1024,
      cpuCores: 20,
      largestHostCpuMhz: 60000, // larger than capacity
      largestHostMemBytes: 60 * 1024 * 1024 * 1024,
      largestHostCpuCores: 30,
    };
    const result = n1Usable(cluster);
    expect(result.cpuMhz).toBe(0);
    expect(result.memBytes).toBe(0);
    expect(result.cpuCores).toBe(0);
  });
});

describe('rollupSite', () => {
  it('sums cluster metrics across a site', () => {
    const clusters = [
      {
        cpuMhzCapacity: 100000,
        cpuMhzUsed: 50000,
        cpuCores: 20,
        memBytesCapacity: 100 * 1024 * 1024 * 1024,
        memBytesUsed: 50 * 1024 * 1024 * 1024,
        vcpuAllocated: 100,
        vmemMbAllocated: 100 * 1024,
        hostCount: 2,
        largestHostCpuMhz: 40000,
        largestHostMemBytes: 40 * 1024 * 1024 * 1024,
        largestHostCpuCores: 10,
      },
      {
        cpuMhzCapacity: 80000,
        cpuMhzUsed: 40000,
        cpuCores: 16,
        memBytesCapacity: 80 * 1024 * 1024 * 1024,
        memBytesUsed: 40 * 1024 * 1024 * 1024,
        vcpuAllocated: 80,
        vmemMbAllocated: 80 * 1024,
        hostCount: 2,
        largestHostCpuMhz: 35000,
        largestHostMemBytes: 35 * 1024 * 1024 * 1024,
        largestHostCpuCores: 8,
      },
    ];

    const result = rollupSite(clusters);

    expect(result.cpuMhzCapacity).toBe(180000);
    expect(result.cpuMhzUsed).toBe(90000);
    expect(result.cpuCores).toBe(36);
    expect(result.memBytesCapacity).toBe(180 * 1024 * 1024 * 1024);
    expect(result.memBytesUsed).toBe(90 * 1024 * 1024 * 1024);
    expect(result.vcpuAllocated).toBe(180);
    expect(result.vmemMbAllocated).toBe(180 * 1024);
    expect(result.usableCpuMhz).toBe(105000); // (100k - 40k) + (80k - 35k)
    expect(result.usableMemBytes).toBe(105 * 1024 * 1024 * 1024);
    expect(result.usableCpuCores).toBe(18); // (20 - 10) + (16 - 8)
  });

  it('handles missing cluster metrics as zero', () => {
    const clusters = [{ hostCount: 1 }];
    const result = rollupSite(clusters);

    expect(result.cpuMhzCapacity).toBe(0);
    expect(result.cpuMhzUsed).toBe(0);
    expect(result.memBytesCapacity).toBe(0);
    expect(result.memBytesUsed).toBe(0);
    expect(result.vcpuAllocated).toBe(0);
    expect(result.vmemMbAllocated).toBe(0);
  });
});

describe('failoverMatrix', () => {
  it('computes fit status: both true when all resources fit', () => {
    const sites = [
      {
        name: 'Site-A',
        cpuMhzUsed: 50000,
        memBytesUsed: 50 * 1024 * 1024 * 1024,
        vcpuAllocated: 100,
        vmemMbAllocated: 100 * 1024,
        usableCpuMhz: 100000,
        usableMemBytes: 100 * 1024 * 1024 * 1024,
        usableCpuCores: 50,
      },
      {
        name: 'Site-B',
        cpuMhzUsed: 40000,
        memBytesUsed: 40 * 1024 * 1024 * 1024,
        vcpuAllocated: 80,
        vmemMbAllocated: 80 * 1024,
        usableCpuMhz: 100000,
        usableMemBytes: 100 * 1024 * 1024 * 1024,
        usableCpuCores: 50,
      },
    ];

    const result = failoverMatrix(sites);

    expect(result).toHaveLength(2);
    expect(result[0].target).toBe('Site-A');
    expect(result[0].memUsedPct).toBe(90); // (50+40)*1GB / 100GB
    expect(result[0].cpuUsedPct).toBe(90); // (50+40)k / 100k
    expect(result[0].fits).toBe(true);
    expect(result[1].target).toBe('Site-B');
    expect(result[1].memUsedPct).toBe(90);
    expect(result[1].cpuUsedPct).toBe(90);
    expect(result[1].fits).toBe(true);
  });

  it('computes fit status: false when memory overflow', () => {
    const sites = [
      {
        name: 'Site-Small',
        cpuMhzUsed: 10000,
        memBytesUsed: 80 * 1024 * 1024 * 1024,
        vcpuAllocated: 50,
        vmemMbAllocated: 50 * 1024,
        usableCpuMhz: 100000,
        usableMemBytes: 50 * 1024 * 1024 * 1024, // only 50GB, but 80GB used
        usableCpuCores: 50,
      },
    ];

    const result = failoverMatrix(sites);

    expect(result[0].fits).toBe(false);
    expect(result[0].memUsedPct).toBeGreaterThan(100);
  });

  it('computes fit status: false when cpu overflow', () => {
    const sites = [
      {
        name: 'Site-SmallCpu',
        cpuMhzUsed: 150000, // huge demand
        memBytesUsed: 10 * 1024 * 1024 * 1024,
        vcpuAllocated: 50,
        vmemMbAllocated: 50 * 1024,
        usableCpuMhz: 100000, // only 100k available
        usableMemBytes: 100 * 1024 * 1024 * 1024,
        usableCpuCores: 50,
      },
    ];

    const result = failoverMatrix(sites);

    expect(result[0].fits).toBe(false);
    expect(result[0].cpuUsedPct).toBeGreaterThan(100);
  });

  it('computes vcpuPerCore ratio', () => {
    const sites = [
      {
        name: 'Site-Balanced',
        cpuMhzUsed: 0,
        memBytesUsed: 0,
        vcpuAllocated: 200,
        vmemMbAllocated: 0,
        usableCpuMhz: 100000,
        usableMemBytes: 100 * 1024 * 1024 * 1024,
        usableCpuCores: 100, // 200 vCPU / 100 cores = 2.0 ratio
      },
    ];

    const result = failoverMatrix(sites);

    expect(result[0].vcpuPerCore).toBeCloseTo(2.0);
  });

  it('computes memAllocPct', () => {
    const sites = [
      {
        name: 'Site-MemAlloc',
        cpuMhzUsed: 0,
        memBytesUsed: 0,
        vcpuAllocated: 0,
        vmemMbAllocated: 50 * 1024, // 50GB allocated
        usableCpuMhz: 100000,
        usableMemBytes: 100 * 1024 * 1024 * 1024, // 100GB usable
        usableCpuCores: 50, // 50GB / 100GB = 50%
      },
    ];

    const result = failoverMatrix(sites);

    expect(result[0].memAllocPct).toBe(50);
  });

  it('handles empty sites list', () => {
    const result = failoverMatrix([]);
    expect(result).toEqual([]);
  });
});
