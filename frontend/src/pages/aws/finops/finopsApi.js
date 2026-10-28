// All FinOps fetch calls live here. Money fields are numbers (already rounded by the server).
// Response shapes are documented in the FinOps contract; every function returns response.data.
import client from '../../../api/client';

const get = (path, params, timeout) => client.get(`/aws${path}`, { params, ...(timeout ? { timeout } : {}) }).then((r) => r.data);

// GET /finops/overview?metric=&accountId=
// { metric, amortizedFrom, month, kpis{...}, mix[{service,usd,pct}], trend[{month,usd,forecastUsd,forecastLowUsd,forecastHighUsd}],
//   topMovers[{service,thisMonthUsd,lastMonthUsd,deltaUsd,deltaPct}], budgets[...], anomalies[...], capabilities[...],
//   lastCaptureAt, lastCaptureRequests }
export const getOverview = (params) => get('/finops/overview', params);

// GET /finops/allocation?dimension=&key=&days|from,to&tz=&metric=
// { dimension, key, keysAvailable{tag,cost_category,linked_account}, metric, range, totalUsd, allocatedUsd, unallocatedUsd,
//   unallocatedPct, coverageGapPct, coverageGapFlag, values[{value,usd,pct,services[{service,usd}]}], days[{day,values{}}] }
export const getAllocation = (params, timeout) => get('/finops/allocation', params, timeout);
export const ALLOCATION_CSV = '/aws/finops/allocation/export.csv';

// GET /finops/commitments?days|from,to&tz=
// { range, savingsPlans{utilization[],coverage[],plans[],recommendations[],summary{}}, reservations{utilization[],coverage[]}, capabilities[] }
export const getCommitments = (params, timeout) => get('/finops/commitments', params, timeout);

// GET /finops/anomalies?status=&source=&days|from,to&tz=
// { range, anomalies[{id,anomalyId,source,scope,scopeKey,monitorName,startDay,endDay,actualUsd,expectedUsd,impactUsd,impactPct,rootCauses[],status,...}],
//   monitors[], rule{pct,floorUsd,baselineDays,clearDays}, capabilities[] }
export const getAnomalies = (params, timeout) => get('/finops/anomalies', params, timeout);

// GET /finops/budgets -> { budgets[{..., status|null}], scopes{services,tagKeys,tagValues,accounts} }
export const getBudgets = () => get('/finops/budgets');
export const createBudget = (body) => client.post('/aws/finops/budgets', body).then((r) => r.data);
export const updateBudget = (id, body) => client.put(`/aws/finops/budgets/${id}`, body).then((r) => r.data);
export const deleteBudget = (id) => client.delete(`/aws/finops/budgets/${id}`).then((r) => r.data);
export const evaluateBudgets = () => client.post('/aws/finops/budgets/evaluate').then((r) => r.data);

// GET /finops/unit-economics?days|from,to&tz=&metric= -> { range, metric, bedrock[], ec2[], s3{}, lightsail{} }
export const getUnitEconomics = (params, timeout) => get('/finops/unit-economics', params, timeout);

// GET /finops/capabilities -> { capabilities[], lastCaptureAt, lastCaptureRequests, estimatedDailyUsd, missingActions[], policy }
export const getCapabilities = () => get('/finops/capabilities');
export const refreshFinops = () => client.post('/aws/finops/refresh').then((r) => r.data);
export const sendDigest = () => client.post('/aws/finops/digest/send').then((r) => r.data);

// GET /finops/resources?days|from,to&tz&metric&kind&service&usageType&q&accountId&limit
// { range, metric, totals{totalUsd,attributedUsd,unattributedUsd,attributedPct}, byKind[{kind,usd,count}],
//   rows[{resourceKind,resourceId,label,link,services[],usd,pct,dailyAvgUsd,estMonthlyUsd,days,tags{}}],
//   unattributed[{service,usd,usageTypes}], note, computedAt }
export const getResources = (params, timeout) => get('/finops/resources', params, timeout);
export const RESOURCES_CSV = '/aws/finops/resources/export.csv';
// GET /finops/resources/series?kind&resourceId&days|from,to -> { rows[{day,usd,usageTypes[{usageType,usd}]}] }
export const getResourceSeries = (params, timeout) => get('/finops/resources/series', params, timeout);

// GET /finops/comparison -> { baselineMonth, comparisonMonth, metric, capturedAt, rows[{service,baselineUsd,comparisonUsd,deltaUsd,deltaPct,drivers[]}] }
export const getComparison = () => get('/finops/comparison');

// GET /finops/pricing -> { refreshedAt, rows, byService[{serviceCode,n}], sample[] }; POST /finops/pricing/refresh
export const getPricing = () => get('/finops/pricing');
export const refreshPricing = () => client.post('/aws/finops/pricing/refresh').then((r) => r.data);

// GET /optimizer?status=&includeShadowed=1 ; POST /optimizer/state { key, status, note }
export const getOptimizer = (params) => get('/optimizer', params);
export const setRecState = (body) => client.post('/aws/optimizer/state', body).then((r) => r.data);

// GET/PUT /config
export const getConfig = () => get('/config');
export const putConfig = (body) => client.put('/aws/config', body).then((r) => r.data);

export const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;
