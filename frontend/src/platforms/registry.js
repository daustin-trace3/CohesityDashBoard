import cohesity from './cohesity/index.jsx';
import pure from './pure/index.jsx';
import netapp from './netapp/index.jsx';
import zerto from './zerto/index.jsx';
import vcenter from './vcenter/index.jsx';
import dell from './dell/index.jsx';

export const platforms = [cohesity, pure, netapp, zerto, vcenter, dell];

export function getPlatform(id) {
  return platforms.find(p => p.id === id);
}
