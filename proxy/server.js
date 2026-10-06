const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const target = new URL(req.url, "http://localhost").searchParams.get("url");
  if (!target) {
    res.writeHead(400);
    res.end("Missing url parameter");
    return;
  }

  https
    .get(
      target,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        },
      },
      (upstream) => {
        res.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(res);
      }
    )
    .on("error", (err) => {
      res.writeHead(502);
      res.end(`Proxy error: ${err.message}`);
    });
});

server.listen(PORT, () => {
  console.log(`Proxy listening on port ${PORT}`);
});
