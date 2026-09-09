// Sdílené konstanty pro index.html, quick.html, water.html a fasting.html.
//
// Důvod: Firebase konfigurace i konstanty jako cíl půstu/vody byly dřív
// zkopírované zvlášť do každého ze 4 HTML souborů - u FASTING_GOAL_MIN se
// to jednou reálně rozešlo (index.html i fasting.html chvíli počítaly s
// jinou hodnotou cíle, než bylo zamýšleno). Tenhle soubor je teď jediné
// místo pravdy - při úpravě stačí nahrát na GitHub jen jeho, ne upravovat
// kopie ve čtyřech různých souborech.
//
// DŮLEŽITÉ PRO NASAZENÍ: tenhle soubor musí ležet ve STEJNÉ složce
// (repozitáři) jako index.html/quick.html/water.html/fasting.html - ty ho
// načítají relativní cestou "./shared-config.js". Při nahrávání na GitHub
// ho tedy nahraj vedle ostatních souborů appky, stejným postupem jako je.

export const firebaseConfig = {
  apiKey: "AIzaSyCeOsvSECUhxjCQ7y2fFv3ybkxw2vsHwEo",
  authDomain: "vtipnici.firebaseapp.com",
  projectId: "vtipnici",
  storageBucket: "vtipnici.firebasestorage.app",
  messagingSenderId: "803980056829",
  appId: "1:803980056829:web:1358b51db8b3e706e50694"
};

// Cíl: 13 hodin bez jídla (zbylých 11 hodin dne je okno, kdy se smí jíst),
// vyjádřeno v minutách. Appka ukládá tuhle hodnotu do každého založeného
// půstu zvlášť (pole cilMin), takže budoucí změna cíle - stačí přepsat
// tuhle konstantu na jednom místě - zpětně nezmění vyhodnocení už
// uložených půstů. Žádné uživatelské rozhraní pro změnu cíle appka
// záměrně nemá (na výslovné přání Iri).
export const FASTING_GOAL_MIN = 13 * 60;

// Denní cíl vypité vody v mililitrech.
export const WATER_GOAL_ML = 2000;
