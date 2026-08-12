#!/usr/bin/env node
/**
 * Open the credentials setup form in your browser
 * This is a one-time setup to store credentials in Supabase
 */

import http from "http"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { exec } from "child_process"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const formPath = path.join(__dirname, "..", "setup-credentials.html")

// Function to find an available port
const findAvailablePort = (startPort) => {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const testServer = http.createServer()
      testServer.listen(port, () => {
        testServer.close(() => resolve(port))
      })
      testServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          tryPort(port + 1)
        } else {
          resolve(port)
        }
      })
    }
    tryPort(startPort)
  })
}

// Get available port and start server
const PORT = await findAvailablePort(3000)

// Read the HTML form
const htmlContent = fs.readFileSync(formPath, "utf-8")

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") {
    res.writeHead(200)
    res.end()
    return
  }

  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(htmlContent)
  } else if (req.url === "/api/deploy" && req.method === "POST") {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk.toString()
    })
    req.on("end", async () => {
      try {
        const data = JSON.parse(body)
        const token = data.token

        if (!token) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "No token provided" }))
          return
        }

        // Store token temporarily for CLI to use
        fs.writeFileSync(
          path.join(__dirname, "..", ".supabase-token-temp"),
          token,
          { mode: 0o600 }
        )

        console.log("\n🚀 Starting deployment...")

        // Deploy Edge Function
        exec(
          `cd ${path.join(__dirname, "..")} && SUPABASE_ACCESS_TOKEN="${token}" npx supabase functions deploy store-credentials --no-verify-jwt`,
          (error, stdout, stderr) => {
            if (error) {
              console.error("Deploy failed:", error.message)
              console.error("stderr:", stderr)
              res.writeHead(500, { "Content-Type": "application/json" })
              res.end(
                JSON.stringify({
                  error: "Deployment failed: " + error.message,
                })
              )
            } else {
              console.log("✅ Edge Function deployed!")
              console.log(stdout)

              // Also run migration
              exec(
                `cd ${path.join(__dirname, "..")} && SUPABASE_ACCESS_TOKEN="${token}" npx supabase migrations up`,
                (migError, migStdout, migStderr) => {
                  if (migError) {
                    console.warn("Migration warning:", migError.message)
                    // Don't fail on migration errors, deployment succeeded
                  } else {
                    console.log("✅ Database migration applied!")
                  }

                  // Clean up token file
                  try {
                    fs.unlinkSync(
                      path.join(__dirname, "..", ".supabase-token-temp")
                    )
                  } catch (e) {
                    // Ignore
                  }

                  res.writeHead(200, { "Content-Type": "application/json" })
                  res.end(JSON.stringify({ success: true }))
                }
              )
            }
          }
        )
      } catch (error) {
        console.error("Parse error:", error.message)
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Invalid JSON" }))
      }
    })
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("Not Found")
  }
})

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`
  console.log("")
  console.log("🔐 Choice Credentials Setup Form")
  console.log("================================")
  console.log("")
  console.log(`✨ Opening form at: ${url}`)
  console.log("")
  console.log("📝 Instructions:")
  console.log("  1. Enter your API credentials:")
  console.log("     - Supabase Project URL")
  console.log("     - Supabase Anon Key")
  console.log("     - Supabase Service Role Key")
  console.log("     - Supabase API Token")
  console.log("     - GitHub Personal Access Token")
  console.log("  2. Click 'Store Credentials Securely'")
  console.log("  3. If successful, close this page")
  console.log("  4. Press Ctrl+C to stop the server")
  console.log("")
  console.log("⚠️  Keep the server running while you submit the form!")
  console.log("")

  // Try to open browser automatically
  const commands = [
    `open "${url}"`, // macOS
    `start ${url}`, // Windows
    `xdg-open "${url}"`, // Linux
  ]

  let opened = false
  for (const cmd of commands) {
    try {
      exec(cmd, (error) => {
        if (!error && !opened) {
          opened = true
          console.log("✅ Opened in browser\n")
        }
      })
      break
    } catch (e) {
      // Try next command
    }
  }

  if (!opened) {
    console.log(`⚠️  Could not auto-open browser. Please visit: ${url}\n`)
  }
})

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\n👋 Closing setup server")
  server.close(() => {
    console.log("✅ Done\n")
    process.exit(0)
  })
})
