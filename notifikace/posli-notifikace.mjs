// Odeslání push notifikací k termínům poznámek appky Vtipníci (3. 11. 2026).
//
// Spouští ho GitHub Actions (.github/workflows/notifikace.yml) každou celou
// hodinu - na pokyn služby cron-job.org (přesné spuštění), se záložním
// plánem přímo v GitHubu pro případ, že by cron-job.org vypadl.
//
// Co dělá při každém spuštění:
//   1. Najde poznámky, jejichž termín (datum `termin` + hodina `terminCas`,
//      chybějící čas = 20:00 stejně jako v appce) už nastal, ale ne před víc
//      než DOHNAT_HODIN hodinami - tím se dorovnají zmeškaná spuštění, ale po
//      delším výpadku nepřijde lavina starých upozornění.
//   2. Přeskočí poznámky v koši a poznámky ZALOŽENÉ až po čase svého
//      termínu (appka nové poznámce předvyplní aktuální hodinu, takže úkol
//      založený ve 14:35 na dnešek má čas 14:00 - na takový se neupozorňuje,
//      domluveno s Iri 3. 11. 2026).
//   3. Každou poznámku pro daný termín pošle jen JEDNOU: před odesláním
//      založí v kolekci `pushOdeslano` dokument `<idPoznámky>_<datum>_<hodina>`
//      (create() selže, pokud už existuje - funguje to i jako zámek proti
//      souběžnému běhu). Když se termín poznámky změní, vznikne nový klíč a
//      upozornění přijde znovu v novém čase.
//   4. Pošle notifikaci na všechny odběry (`pushOdbery`) majitele poznámky.
//      Odběry, které push služba hlásí jako zaniklé (404/410), smaže.
//
// Proměnné prostředí (GitHub Secrets):
//   FIREBASE_SERVICE_ACCOUNT  celý JSON servisního účtu z Firebase Console
//   VAPID_PRIVATE_KEY         soukromý VAPID klíč (pár k VAPID_PUBLIC_KEY níže)
//   TEST_NOTIFIKACE=true      (volitelné, ruční spuštění) pošle jen zkušební
//                             notifikaci na všechny odběry

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import webpush from "web-push";
import { pathToFileURL } from "node:url";

const VAPID_PUBLIC_KEY = "BLP4lrkNgyOd2N5stc8IHQezIQlR3KCHwBdcW8NSpygrusKZ71SsgLqS7qqvjBCBCkR5ol0s3cowR6urv_OG_4I";
const VAPID_SUBJECT = "https://github.com/laira627/vtipnici";
const TIME_ZONE = "Europe/Prague";
const VYCHOZI_HODINA = 20; // stejné jako effectiveTerminCas() v index.html
const DOHNAT_HODIN = 6;

// ---------- Čas v Praze ----------

// Vrátí { date: "YYYY-MM-DD", hour: 0-23 } pro daný okamžik v pražském čase.
export function pragueParts(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(ms)).map(p => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

// Okamžik (ms od epochy), kdy v Praze nastane daný den a celá hodina.
export function pragueToMs(dateStr, hour) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  // Posun Prahy vůči UTC v tu chvíli (1 h v zimě, 2 h v létě).
  const p = pragueParts(guess);
  const [py, pm, pd] = p.date.split("-").map(Number);
  const offsetMs = Date.UTC(py, pm - 1, pd, p.hour) - guess;
  return guess - offsetMs;
}

export function addDays(dateStr, days) {
  const dt = new Date(dateStr + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function effectiveHour(note) {
  return Number.isInteger(note.terminCas) ? note.terminCas : VYCHOZI_HODINA;
}

function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts === "number") return ts;
  return null;
}

// Vybere poznámky, na které se má teď upozornit (bez ohledu na to, jestli už
// upozornění odešlo - to hlídá pushOdeslano). Čistá funkce kvůli testům.
export function selectDueNotes(notes, nowMs) {
  const result = [];
  for (const n of notes) {
    if (!n.termin || n.smazano) continue;
    const hour = effectiveHour(n);
    const dueMs = pragueToMs(n.termin, hour);
    if (dueMs > nowMs) continue;                              // ještě nenastal
    if (dueMs <= nowMs - DOHNAT_HODIN * 3600 * 1000) continue; // příliš starý
    const createdMs = toMillis(n.vytvoreno);
    if (createdMs != null && createdMs > dueMs) continue;     // založena až po termínu
    result.push({ ...n, hour, dueMs });
  }
  return result;
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${d}.${m}.${y}`;
}

function stripHtml(html) {
  return (html || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

export function buildPayload(note, todayStr) {
  const nazev = (note.nazev || "").trim() || stripHtml(note.popis).slice(0, 60) || "Poznámka";
  const kdy = String(note.hour).padStart(2, "0") + ":00";
  const den = note.termin === todayStr ? "dnes" : formatDate(note.termin);
  return {
    title: `📌 ${nazev}`,
    body: `Termín ${den} v ${kdy}${note.druh ? " · " + note.druh : ""}`,
    noteId: note.id
  };
}

// ---------- Hlavní běh ----------

async function sendToSubscriptions(db, subs, payload) {
  let delivered = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: s.keys },
        JSON.stringify(payload),
        { TTL: DOHNAT_HODIN * 3600, urgency: "high" }
      );
      delivered++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        console.log(`Odběr ${s.id} už neplatí (${err.statusCode}) - mažu.`);
        await db.collection("pushOdbery").doc(s.id).delete();
      } else {
        console.error(`Odeslání na odběr ${s.id} selhalo:`, err.statusCode || "", err.body || err.message);
      }
    }
  }
  return delivered;
}

async function main() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "null");
  if (!serviceAccount) throw new Error("Chybí secret FIREBASE_SERVICE_ACCOUNT.");
  if (!process.env.VAPID_PRIVATE_KEY) throw new Error("Chybí secret VAPID_PRIVATE_KEY.");

  initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY.trim());

  const subsSnap = await db.collection("pushOdbery").get();
  const subsByUid = new Map();
  subsSnap.docs.forEach(d => {
    const s = { id: d.id, ...d.data() };
    if (!s.uid || !s.endpoint || !s.keys) return;
    if (!subsByUid.has(s.uid)) subsByUid.set(s.uid, []);
    subsByUid.get(s.uid).push(s);
  });
  console.log(`Odběrů: ${subsSnap.size}`);

  if (process.env.TEST_NOTIFIKACE === "true") {
    const all = [...subsByUid.values()].flat();
    const ok = await sendToSubscriptions(db, all, {
      title: "🔔 Zkušební upozornění",
      body: "Notifikace z appky Vtipníci fungují.",
      noteId: null
    });
    console.log(`Zkušební notifikace doručeny na ${ok} z ${all.length} odběrů.`);
    return;
  }

  if (subsByUid.size === 0) {
    console.log("Žádné odběry - není komu posílat.");
    return;
  }

  const nowMs = Date.now();
  const today = pragueParts(nowMs).date;
  // Okno DOHNAT_HODIN hodin může sahat přes půlnoc, proto i včerejšek.
  const notesSnap = await db.collection("poznamky")
    .where("termin", ">=", addDays(today, -1))
    .where("termin", "<=", today)
    .get();
  const notes = notesSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(n => subsByUid.has(n.uid));
  const due = selectDueNotes(notes, nowMs);
  console.log(`Poznámek s termínem včera/dnes: ${notes.length}, k upozornění teď: ${due.length}`);

  let sent = 0;
  for (const note of due) {
    const key = `${note.id}_${note.termin}_${note.hour}`;
    try {
      await db.collection("pushOdeslano").doc(key).create({
        uid: note.uid, noteId: note.id, termin: note.termin, hodina: note.hour,
        odeslano: FieldValue.serverTimestamp()
      });
    } catch (err) {
      if (err.code === 6 /* ALREADY_EXISTS */) continue; // už upozorněno
      throw err;
    }
    const delivered = await sendToSubscriptions(db, subsByUid.get(note.uid), buildPayload(note, today));
    console.log(`„${note.nazev || note.id}“ (${note.termin} ${note.hour}:00) → doručeno na ${delivered} zařízení`);
    sent++;
  }
  console.log(`Hotovo, odesláno upozornění: ${sent}`);

  // Úklid záznamů o odeslání starších než 14 dní, ať kolekce neroste donekonečna.
  const old = await db.collection("pushOdeslano").where("termin", "<", addDays(today, -14)).limit(400).get();
  if (!old.empty) {
    const batch = db.batch();
    old.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    console.log(`Smazáno starých záznamů o odeslání: ${old.size}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
