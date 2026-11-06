import LmLoadBalancersPage from '../logicmonitor/LmLoadBalancersPage';

// The LogicMonitor load balancer page and 360 read their data through apiBase;
// here they read /api/f5, which serves the same payload for F5 devices only.
export default function F5LoadBalancersPage() {
  return (
    <LmLoadBalancersPage
      apiBase="/f5"
      title="Load Balancers"
      description="BIG-IP failover, pools, GTM wide IPs, daemons and certificates, read from the LogicMonitor portals that monitor these devices"
    />
  );
}
