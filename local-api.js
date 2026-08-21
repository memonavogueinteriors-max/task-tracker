const http = require('http');
const { URL } = require('url');
const handler = require('./api/index.js');

const server = http.createServer((req, res) => {
  // Allow the frontend on localhost:3000 to call the API on 3001
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  let body = '';

  req.on('data', chunk => {
    body += chunk;
  });

  req.on('end', async () => {
    try {
      req.query = Object.fromEntries(url.searchParams.entries());
      req.body = body.trim() ? JSON.parse(body) : {};

      res.status = (code) => {
        res.statusCode = code;
        return res;
      };

      res.json = (data) => {
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'application/json');
        }
        res.end(JSON.stringify(data));
      };

      res.send = (data) => {
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'application/json');
        }
        res.end(typeof data === 'string' ? data : JSON.stringify(data));
      };

      await handler(req, res);
    } catch (error) {
      console.error('LOCAL API ERROR:', error);

      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message }));
      }
    }
  });
});

server.listen(3001, () => {
  console.log('API running at http://localhost:3001');
});
