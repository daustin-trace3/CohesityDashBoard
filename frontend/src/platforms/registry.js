import cohesity from './cohesity/index.jsx';
import pure from './pure/index.jsx';
import netapp from './netapp/index.jsx';
import zerto from './zerto/index.jsx';
import netbackup from './netbackup/index.jsx';
import vcenter from './vcenter/index.jsx';
import dell from './dell/index.jsx';
import aria from './aria/index.jsx';
import ariaops from './ariaops/index.jsx';
import aws from './aws/index.jsx';
import nutanix from './nutanix/index.jsx';

export const platforms = [cohesity, pure, netapp, zerto, netbackup, vcenter, dell, aria, ariaops, aws, nutanix];

export function getPlatform(id) {
  return platforms.find(p => p.id === id);
}
