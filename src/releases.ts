import history from './releases.json';

export { history as releases };

export function releaseChanges(changes: string[]) {
  const list = document.createElement('ul');
  list.className = 'release-changes';
  for (const change of changes) {
    const item = document.createElement('li');
    item.textContent = change;
    list.append(item);
  }
  return list;
}
