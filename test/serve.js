/* Minimal static file server for testing the Exam Proctor extension.
 * Serves this `test/` folder on http://localhost:8000  (no dependencies).
 *   node serve.js          → port 8000
 *   node serve.js 9000     → port 9000
 * The extension is configured to proctor http://localhost:8000/take/*  */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.argv[2]) || 8000;
const ROOT = __dirname;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/take/exam.html";

  // Resolve safely inside ROOT (block path traversal).
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found: " + urlPath);
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Test server running:  http://localhost:${PORT}/take/exam.html?student=Jane%20Doe&examId=DEMO101`);
  console.log("Press Ctrl+C to stop.");
});
