import cohesity from './cohesity/index.jsx';

export const platforms = [cohesity];

export function getPlatform(id) {
  return platforms.find(p => p.id === id);
}
