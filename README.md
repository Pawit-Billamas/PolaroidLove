# Together Booth 💌

A polaroid photobooth for two — on two separate devices, anywhere.

One person creates a room and picks a frame; the other joins with a short code
(like `TULIP-84`). The two browsers open a **direct, peer-to-peer WebRTC video
call** — no photo or video is ever uploaded to a server. When both people tap
**"I'm ready,"** a synced countdown runs on both screens at once, and at zero
both devices independently draw their own camera + their partner's live video
into a canvas, producing an identical polaroid keepsake for each of you.

## What's inside

```
photobooth-together/
├── server.js          Express server + self-hosted WebRTC signaling (PeerJS)
├── package.json
├── public/
│   ├── index.html      App shell (5 screens: home → design → lobby → capture → result)
│   ├── style.css        Design system — palette/type sampled from your mood board
│   └── app.js           Camera, WebRTC/PeerJS, sync countdown, canvas rendering
└── README.md           (this file)
```

### The design
Colors, shapes, and type were pulled directly from the reference mood board:
hot pink hero surfaces, warm cream cards, sky-blue and leaf-green accents,
a scalloped divider echoing the card's wavy edge, pill buttons, and a script
accent font (`Beau Rivage`) paired with a bold geometric sans (`Poppins`) for
headings and `Nunito Sans` for body text. Button/background color pairs were
checked against WCAG contrast so text stays readable.

### The polaroid frame, modernized
Three frame shapes, each in your choice of pink / sky / leaf accent:
- **Classic Modern** — one merged photo, split down the middle or across,
  in a rounded card with a thin double ring border.
- **Studio Duo** — two separate square frames stacked like a real two-frame
  photobooth strip, with a perforated tear line between them.
- **Bloom Cutout** — the merged photo cropped into a soft organic blob shape
  with a thin colored ring outline, echoing the product-card shapes on the
  mood board.

All three use a plain, modern caption bar (no stickers/washi tape/grain) —
just a small color dot, your caption, and the date.

## How the two-device connection works

- Both devices load the same web app and both run **PeerJS**, a thin wrapper
  around WebRTC.
- The **host** picks a frame and generates a short room code. Their browser
  registers with our server's signaling endpoint *using that code as its
  peer ID*.
- The **guest** enters the code. Their browser calls that peer ID directly.
- Once connected, video flows **peer-to-peer** — your server only ever
  brokers the initial handshake (who's who, and each side's network
  address), never the actual photos or video stream.
- A small WebRTC data channel carries just three kinds of tiny control
  messages: the host's frame choice, "I'm ready," and the "3, 2, 1, capture"
  ticks — so both countdowns fire in lockstep.

This was tested end-to-end against the real signaling server (room
registration, and the exact "room code already taken" collision path) before
being handed to you — see the "Verifying your deploy" section below for how
to spot-check it yourself after deploying.

---

## 1. Run it locally first

You'll need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd photobooth-together
npm install
npm start
```

Open **http://localhost:3000** in two different browsers (e.g. Chrome and
Firefox, or Chrome and an incognito window) to test the two-person flow on
one machine. Note: to test camera + WebRTC across two *actual* separate
devices on your home network, you'll need HTTPS (see the note in step 3) —
`localhost` is exempt from that requirement, which is why testing two tabs
on one machine works fine without it.

## 2. Push it to GitHub

If your project isn't already a git repo:

```bash
cd photobooth-together
git init
git add .
git commit -m "Together Booth"
```

Create a new empty repository on [github.com/new](https://github.com/new),
then:

```bash
git remote add origin https://github.com/<your-username>/together-booth.git
git branch -M main
git push -u origin main
```

## 3. Deploy to Render (free, no credit card)

Render can build and run this repo with zero config beyond the two
commands below.

1. Go to [render.com](https://render.com) and sign up / log in (you can use
   your GitHub account).
2. Click **New → Web Service**.
3. Connect your GitHub account and select the `together-booth` repo.
4. Fill in:
   - **Name**: anything, e.g. `together-booth`
   - **Region**: closest to you or your partner
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**
5. Click **Create Web Service**. Render will build and deploy — you'll get
   a live URL like `https://together-booth.onrender.com` in a minute or two.
6. Open that URL — camera access requires HTTPS in every browser except on
   `localhost`, and Render gives you HTTPS automatically, so you're covered.

**Good to know about the free instance:** it spins down after 15 minutes
with no traffic and takes 30–60 seconds to wake back up on the next
request. That's completely fine for "we're about to take a photo together
right now" use — just expect the *very first* load after a quiet period to
take a moment. If you want it always warm (e.g. sharing the link often),
Render's paid Starter instance ($7/mo at time of writing) removes the
spin-down; check Render's current pricing since this changes over time.

### Alternatives to Render
- **Railway** ([railway.app](https://railway.app)) — similarly simple
  "connect repo, deploy" flow, usage-based pricing with a small free credit.
- **Fly.io** — more control over region/instance sizing if you want the app
  running close to both of you specifically.

Any host that runs a persistent Node.js process and supports WebSockets
works — this app has no other infrastructure requirements (no database, no
file storage).

## 4. (Optional) Add a TURN server for tougher networks

The app ships with free public STUN servers, which is enough for most
wifi-to-wifi or wifi-to-mobile-data pairings. Some networks (hotel wifi,
corporate/campus firewalls, some carrier-grade NATs) block direct
peer-to-peer connections entirely, and STUN alone can't get through — that's
what a TURN server is for; it relays the call instead of connecting the two
devices directly.

If you find a connection that just won't complete, add a free TURN
provider — [Metered's Open Relay project](https://www.metered.ca/tools/openrelay/)
currently offers a free monthly tier. After signing up and getting
credentials, add these three environment variables in your host's
dashboard (Render: **Environment** tab on your service):

```
TURN_URL=turn:<the-host-they-give-you>:80
TURN_USERNAME=<from your dashboard>
TURN_CREDENTIAL=<from your dashboard>
```

`server.js` already reads these automatically and adds them to the ICE
config it hands to the frontend — no code changes needed. Redeploy (or just
restart the service) after setting them.

## 5. Verifying your deploy

Once it's live:

1. Open the URL on your own phone/laptop, choose **Create a room**, pick a
   frame, and confirm you land on a screen showing a room code and your own
   camera preview.
2. Open the same URL on a second device (or ask your partner to), choose
   **Join a room**, and enter the code.
3. Both sides should show each other's live video within a few seconds. If
   it hangs on "Waiting for them to join…" for more than ~15–20 seconds,
   that's usually a NAT/firewall situation — see the TURN section above.
4. Tap **I'm ready** on both devices — the countdown should start on both
   screens within a moment of the second person tapping ready, and both
   people should end up with a matching photo they can download.

## Customizing

- **Colors** — all in the `:root` block at the top of `public/style.css`.
- **Fonts** — swap the Google Fonts `<link>` in `index.html` and the
  `--font-*` variables in `style.css`; keep the caption-drawing font in
  `app.js`'s `drawCaptionBar()` in sync if you change the display font.
- **Room code words** — the `ROOM_WORDS` list near the top of `app.js`.
- **Frame shapes** — each shape has its own `render*()` function in
  `app.js` (`renderClassicModern`, `renderBloomCutout`, `renderStudioDuo`);
  the blob outline itself is the `BLOB_POINTS` array, in case you want a
  different organic shape.
