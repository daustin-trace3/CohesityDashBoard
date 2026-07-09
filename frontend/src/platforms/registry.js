import cohesity from './cohesity/index.jsx';
import pure from './pure/index.jsx';
import netapp from './netapp/index.jsx';

export const platforms = [cohesity, pure, netapp];

export function getPlatform(id) {
  return platforms.find(p => p.id === id);
}
