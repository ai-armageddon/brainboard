import { releases, releaseChanges } from '../src/releases';

const root = document.querySelector('#releases')!;
for (const release of releases) {
  const article = document.createElement('article');
  const version = document.createElement('small');
  version.textContent = `v${release.version}`;
  const heading = document.createElement('h2');
  heading.textContent = release.title;
  article.append(version, heading, releaseChanges(release.changes));
  root.append(article);
}
