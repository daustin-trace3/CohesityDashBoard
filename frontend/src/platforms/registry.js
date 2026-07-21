import cohesity from './cohesity/index.jsx';
import pure from './pure/index.jsx';
import netapp from './netapp/index.jsx';
import zerto from './zerto/index.jsx';

export const platforms = [cohesity, pure, netapp, zerto];

export function getPlatform(id) {
  return platforms.find(p => p.id === id);
}
