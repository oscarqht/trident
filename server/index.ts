import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';

// Handlers
import * as settingsRoute from './api/settings/route';
import * as reposRoute from './api/repos/route';
import * as reposCloneRoute from './api/repos/clone/route';
import * as customScriptsRoute from './api/custom-scripts/route';
import * as fsRoute from './api/fs/route';
import * as fsOpenTerminalRoute from './api/fs/open-terminal/route';
import * as fsOpenRoute from './api/fs/open/route';
import * as gitDiffRoute from './api/git/diff/route';
import * as gitStatusRoute from './api/git/status/route';
import * as gitActionRoute from './api/git/action/route';
import * as gitLogRoute from './api/git/log/route';
import * as gitBranchesRoute from './api/git/branches/route';
import * as credentialsRoute from './api/credentials/route';
import * as credentialsGithubReposRoute from './api/credentials/github/repos/route';

export function createTridentApp() {
  const app = new Hono();
  app.use('*', cors());

  function adapt(handler?: (req: any, ctx?: any) => Promise<Response>) {
    return async (c: any) => {
      if (!handler) return c.json({ error: 'Not found' }, 404);
      const rawReq = c.req.raw;
      rawReq.nextUrl = new URL(rawReq.url);
      const params = c.req.param();
      try {
        const response = await handler(rawReq, { params: Promise.resolve(params) });
        return response;
      } catch (err: any) {
        console.error('API error:', err);
        return c.json({ error: err?.message || 'Internal Server Error' }, 500);
      }
    };
  }

  // Settings
  app.get('/api/settings', adapt(settingsRoute.GET));
  app.put('/api/settings', adapt(settingsRoute.PUT));

  // Repos
  app.get('/api/repos', adapt(reposRoute.GET));
  app.post('/api/repos', adapt(reposRoute.POST));
  app.put('/api/repos', adapt(reposRoute.PUT));
  app.delete('/api/repos', adapt(reposRoute.DELETE));
  app.post('/api/repos/clone', adapt(reposCloneRoute.POST));

  // Custom Scripts
  app.post('/api/custom-scripts', adapt(customScriptsRoute.POST));

  // FS
  app.get('/api/fs', adapt(fsRoute.GET));
  app.post('/api/fs', adapt(fsRoute.POST));
  app.post('/api/fs/open-terminal', adapt(fsOpenTerminalRoute.POST));
  app.post('/api/fs/open', adapt(fsOpenRoute.POST));

  // Git
  app.get('/api/git/diff', adapt(gitDiffRoute.GET));
  app.get('/api/git/status', adapt(gitStatusRoute.GET));
  app.post('/api/git/action', adapt(gitActionRoute.POST));
  app.get('/api/git/log', adapt(gitLogRoute.GET));
  app.get('/api/git/branches', adapt(gitBranchesRoute.GET));

  // Credentials
  app.get('/api/credentials', adapt(credentialsRoute.GET));
  app.post('/api/credentials', adapt(credentialsRoute.POST));
  app.put('/api/credentials', adapt(credentialsRoute.PUT));
  app.delete('/api/credentials', adapt(credentialsRoute.DELETE));
  app.get('/api/credentials/github/repos', adapt(credentialsGithubReposRoute.GET));

  // Static files in production
  app.use('/*', serveStatic({ root: './dist/client' }));
  app.get('/*', serveStatic({ path: './dist/client/index.html' }));

  return app;
}

export function startTridentServer(port = 3100) {
  const app = createTridentApp();
  console.log(`Trident server running on http://localhost:${port}`);
  return serve({
    fetch: app.fetch,
    port,
  });
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('server/index.ts');
if (isDirectRun || process.env.RUN_STANDALONE === 'true') {
  const port = Number(process.env.PORT) || 3101;
  startTridentServer(port);
}
