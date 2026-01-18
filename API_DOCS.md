# Mentrast Invite Service API Documentation

**Base URL**: `https://mentrast-private.onrender.com` (Production)  
*Local Development*: `http://localhost:3001`

## Integration Guide for Main App

The Main App should verify invite tokens before allowing user registration.

### 1. Verification Endpoint
**GET** `/api/verify/:token`

Call this when the user lands on the registration page with `?invite=TOKEN`.

**Response:**
```json
{
  "valid": true,   // true if token exists and is unused
  "reason": "used" // optional: 'used' or 'not_found' if valid is false
}
```

**Example (Next.js/React):**
```javascript
const res = await fetch(`${process.env.NEXT_PUBLIC_INVITE_API_URL}/api/verify/${token}`);
const data = await res.json();
if (data.valid) {
  // Allow access to signup form
} else {
  // Show 404 or Access Denied
}
```

### 2. Consumption Endpoint
**POST** `/api/consume/:token`

Call this **only** after the user has successfully created their account (e.g., after Firebase `createUserWithEmailAndPassword` succeeds).

**Response:**
```json
{
  "success": true,
  "message": "Token consumed"
}
```

**Example:**
```javascript
await fetch(`${process.env.NEXT_PUBLIC_INVITE_API_URL}/api/consume/${token}`, {
  method: 'POST'
});
```

## Environment Variables
Ensure the Main App has the following environment variable set:

```env
NEXT_PUBLIC_INVITE_API_URL=https://mentrast-private.onrender.com
```
