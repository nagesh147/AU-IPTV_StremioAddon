# AU IPTV (EPG + Logos + Networks)

A Stremio add-on that provides Australian IPTV streams with:
- EPG (Electronic Program Guide)
- Channel logos
- Network filtering
- Separate TV and Radio catalogs

Data sourced from [Matt Huisman’s AU IPTV](https://i.mjh.nz/au/).

---

## 📦 Installation (via npm)

```bash
# 1. Clone this repository
git clone https://github.com/YOUR_GITHUB_USERNAME/au-iptv-stremio.git
cd au-iptv-stremio

# 2. Install dependencies
npm install

# 3. Run the add-on locally
npm start


The server will start on:

arduino
Copy
Edit
http://localhost:7000
🌐 Deploying
You can run this anywhere Node.js works — including:

Local machine

VPS (Linux/Windows)

Free serverless hosting (Vercel, Netlify, Render, AWS Lambda, etc.)

📥 Installing in Stremio
Option 1 – Web installer

Go to your add-on’s landing page in a browser:

arduino
Copy
Edit
http://localhost:7000
Select your region & preferences.

Click Open in Stremio Web or Open in Stremio App.

Option 2 – Manual

Copy the generated manifest URL from the landing page.

In Stremio, go to Add-ons → Community Add-ons → Install via URL.

Paste the manifest URL and confirm.

⚙ Configuration
The landing page lets you:

Choose region

Include/Exclude regional channels

Include Radio stations (shown in their own catalog)

🛠 Development
server.js – main add-on logic

Landing page – public/index.html

EPG/Logos/Channels pulled live from i.mjh.nz

To restart after edits:

bash
Copy
Edit
npm start
