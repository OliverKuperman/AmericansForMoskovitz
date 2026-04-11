# Americans for Moskovitz

A professional, multi-page political campaign website built with Node.js, Express, PostgreSQL, and vanilla HTML/CSS/JavaScript. The site hosts information about Dustin Moskovitz and a secure petition encouraging him to run for President in the 2028 Democratic Primary.

---

## Prerequisites

Before you begin, make sure the following are installed on your machine:

| Tool | Minimum Version | Download |
|---|---|---|
| Node.js | 18.x | https://nodejs.org |
| npm | 9.x (bundled with Node.js) | — |
| PostgreSQL | 14.x | https://www.postgresql.org/download |

---

## Project Structure

```
Americans_For_Moskovitz/
├── Images/                        ← Source images (served by the app)
│   ├── Dustin Moskovitz Introduction/
│   ├── Join the Movement/
│   └── AI Safety and Regulation/
├── Info.txt
├── Attribution.txt
└── Code/                          ← Application root
    ├── server.js                  ← Express server + API
    ├── package.json
    ├── .env                       ← Your local config (create from .env.example)
    ├── .env.example               ← Config template
    ├── README.md
    └── public/                    ← Static frontend files
        ├── index.html             ← Home page
        ├── about.html             ← About / Info page
        ├── petition.html          ← Petition page
        ├── attributions.html      ← Image attributions
        ├── styles.css
        └── app.js
```

---

## Setup Instructions

### 1. Install Node.js Dependencies

Open a terminal, navigate to the `Code` folder, and run:

```bash
cd "C:\Users\olive\OneDrive\Desktop\Americans_For_Moskovitz\Code"
npm install
```

This will install all required packages: `express`, `pg`, `helmet`, `express-rate-limit`, and `dotenv`.

---

### 2. Set Up the PostgreSQL Database

Open the **psql** command-line tool (or pgAdmin) and run the following commands to create the database and a dedicated user:

```sql
-- Create the database
CREATE DATABASE moskovitz_petition;

-- Create a dedicated user (replace 'your_password' with a strong password)
CREATE USER moskovitz_user WITH PASSWORD 'your_password';

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE moskovitz_petition TO moskovitz_user;
```

> **Note:** The application will automatically create the `petition_signatures` table the first time it starts. You do not need to create it manually.

---

### 3. Configure Environment Variables

Copy the example file and fill in your credentials:

```bash
# In the Code folder
copy .env.example .env
```

Then open `.env` in a text editor and update the values:

```env
# Server port
PORT=3000

# PostgreSQL connection
DB_HOST=localhost
DB_PORT=5432
DB_NAME=moskovitz_petition
DB_USER=moskovitz_user
DB_PASSWORD=your_password

# Set to "true" only for remote databases over SSL
DB_SSL=false
```

> **Important:** Never commit your `.env` file to version control. It contains sensitive credentials.

---

### 4. Start the Server

```bash
node server.js
```

Or, if you have Node.js 18+ and want auto-restart on file changes during development:

```bash
npm run dev
```

You should see:

```
[DB] Table ready.

  Americans for Moskovitz  →  http://localhost:3000
```

---

### 5. Open the Website

Navigate to **http://localhost:3000** in your browser. The site has four pages:

| Page | URL |
|---|---|
| Home | http://localhost:3000/ |
| About Dustin | http://localhost:3000/about.html |
| Sign the Petition | http://localhost:3000/petition.html |
| Attributions | http://localhost:3000/attributions.html |

---

## Security Features

This application includes several layers of security:

| Feature | Implementation |
|---|---|
| SQL injection prevention | All database queries use parameterized statements (`$1`, `$2`) via the `pg` library |
| Input validation | Server-side regex validation on name and email fields before any database interaction |
| Rate limiting | Petition endpoint is limited to **5 submissions per IP per 15 minutes** via `express-rate-limit` |
| HTTP security headers | `helmet` sets headers including `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, and more |
| Credential isolation | Database credentials are loaded from environment variables — never hardcoded |
| Request size limiting | JSON and URL-encoded bodies are capped at **10 KB** |
| Duplicate prevention | The `email` column has a `UNIQUE` constraint to prevent duplicate petition signatures |
| Client-side validation | Frontend validates fields before submission, providing instant user feedback |

---

## API Endpoints

| Method | Endpoint | Description | Rate Limited |
|---|---|---|---|
| `POST` | `/api/petition` | Submit a petition signature | Yes (5 / 15 min) |
| `GET` | `/api/petition/count` | Get the total signature count | No |

### POST /api/petition

**Request body:**
```json
{
  "name": "Jane Smith",
  "email": "jane@example.com"
}
```

**Success response (200):**
```json
{
  "success": true,
  "count": 42
}
```

**Error responses:**
- `400` — Missing or invalid fields
- `409` — Email already signed
- `429` — Rate limit exceeded
- `500` — Server error

---

## Troubleshooting

**`FATAL: password authentication failed`**
→ Double-check `DB_USER` and `DB_PASSWORD` in your `.env` file match what you set in PostgreSQL.

**`ECONNREFUSED` connecting to PostgreSQL**
→ Make sure the PostgreSQL service is running. On Windows, check Services or run `pg_ctl status`.

**Port 3000 already in use**
→ Change `PORT=3001` (or any free port) in your `.env` file.

**Images not loading**
→ Ensure the `Images` folder is in its original location at `C:\Users\olive\OneDrive\Desktop\Americans_For_Moskovitz\Images\`. The server serves it from one level above the `Code` folder.

---

## Notes

- This is a **grassroots fan project** with no affiliation to Dustin Moskovitz or any official campaign.
- All images are attributed on the [Attributions page](http://localhost:3000/attributions.html) and used in accordance with their respective licenses.
