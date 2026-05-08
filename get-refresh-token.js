// get-refresh-token.js
// Run this ONCE on your Mac to get your Gmail refresh token.
// Then add the token to GitHub Secrets as GMAIL_REFRESH_TOKEN.
//
// Usage:
//   node get-refresh-token.js

const { google } = require('googleapis');
const http = require('http');
const url = require('url');

// ── PASTE YOUR CREDENTIALS HERE ───────────────────────────────────────────────
const CLIENT_ID = process.env.GMAIL_CLIENT_ID || 'PASTE_YOUR_CLIENT_ID_HERE';
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || 'PASTE_YOUR_CLIENT_SECRET_HERE';
// ─────────────────────────────────────────────────────────────────────────────

const REDIRECT_URI = 'http://localhost:3000/callback';
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

async function main() {
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  console.log('\n=== Gmail OAuth Setup ===');
  console.log('\nOpening browser for authorisation...');
  console.log('\nIf it does not open automatically, paste this URL into your browser:\n');
  console.log(authUrl);
  console.log('');

  // Try to open browser automatically
  const { exec } = require('child_process');
  exec(`open "${authUrl}"`);

  // Start local server to catch the callback
  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    if (parsed.pathname !== '/callback') return;

    const code = parsed.query.code;
    if (!code) {
      res.end('No code received. Please try again.');
      return;
    }

    try {
      const { tokens } = await oauth2Client.getToken(code);

      res.end(`
        <html><body style="font-family:sans-serif;padding:2rem;max-width:600px">
          <h2>✅ Authorisation successful!</h2>
          <p>Copy your refresh token below and add it to GitHub Secrets as <code>GMAIL_REFRESH_TOKEN</code>:</p>
          <textarea style="width:100%;height:100px;font-family:monospace;font-size:12px">${tokens.refresh_token}</textarea>
          <p style="color:#666;font-size:14px">You can close this window and the terminal.</p>
        </body></html>
      `);

      console.log('\n✅ Success! Your refresh token:\n');
      console.log(tokens.refresh_token);
      console.log('\nAdd this to GitHub Secrets as: GMAIL_REFRESH_TOKEN\n');

    } catch (err) {
      res.end(`Error: ${err.message}`);
      console.error('Error getting tokens:', err);
    }

    server.close();
  });

  server.listen(3000, () => {
    console.log('Waiting for Gmail authorisation on http://localhost:3000...');
  });
}

main().catch(console.error);
