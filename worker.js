// NoJunk Email Check — a paid (x402) email address verification service for AI agents.
// Checks: RFC 5322 syntax subset, MX/A records via DNS-over-HTTPS, disposable domains, role
// addresses, free-mail providers, typo suggestions, normalization and a risk score.
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet address that receives USDC (defaults to DEFAULT_PAY_TO)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> enables Bazaar listing
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const PRICE_ATOMIC = "1000"; // $0.001 in USDC (6 decimals)
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "NoJunk Email Check";
const DESCRIPTION =
  "Email address verification for AI agents: RFC 5322 syntax check, live MX/A DNS lookup, disposable-domain detection, role-address and free-mail-provider flags, typo suggestions (gmial.com -> gmail.com), normalized form and a low/medium/high risk score. One address or up to 20 per request, same price. No mailbox probing.";

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 5000;
const USER_AGENT = "NoJunk Email Check/1.0 (+https://nojunkcrypto.com)";
const MAX_EMAILS = 20;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MX_HOSTS = 5;

// Top providers used for typo suggestions (Levenshtein distance 1-2).
const TOP_PROVIDERS = [
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com", "protonmail.com", "proton.me", "live.com", "msn.com",
  "me.com", "mac.com", "comcast.net", "gmx.com", "yandex.com", "zoho.com", "mail.com", "ymail.com", "att.net", "verizon.net",
];

// Free / consumer mailbox providers.
const FREE_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.ca", "yahoo.com.au", "yahoo.fr", "yahoo.de", "yahoo.es", "yahoo.it", "yahoo.co.in", "yahoo.com.br", "ymail.com", "rocketmail.com",
  "outlook.com", "outlook.co.uk", "hotmail.com", "hotmail.co.uk", "hotmail.fr", "hotmail.de", "hotmail.it", "hotmail.es", "live.com", "live.co.uk", "live.ca", "msn.com", "passport.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "aim.com", "protonmail.com", "protonmail.ch", "proton.me", "pm.me", "gmx.com", "gmx.net", "gmx.de", "gmx.at", "gmx.ch", "gmx.us",
  "mail.com", "email.com", "usa.com", "zoho.com", "zohomail.com", "yandex.com", "yandex.ru", "ya.ru", "mail.ru", "bk.ru", "inbox.ru", "list.ru", "tutanota.com", "tutanota.de", "tuta.io", "tuta.com",
  "fastmail.com", "fastmail.fm", "hey.com", "hushmail.com", "mailfence.com", "posteo.de", "runbox.com", "web.de", "t-online.de", "freenet.de", "orange.fr", "wanadoo.fr", "laposte.net", "free.fr", "sfr.fr",
  "libero.it", "virgilio.it", "tiscali.it", "seznam.cz", "wp.pl", "onet.pl", "o2.pl", "interia.pl", "rediffmail.com", "sina.com", "sina.cn", "qq.com", "163.com", "126.com", "foxmail.com", "naver.com", "daum.net", "hanmail.net",
  "comcast.net", "att.net", "sbcglobal.net", "bellsouth.net", "verizon.net", "cox.net", "charter.net", "earthlink.net", "optonline.net", "btinternet.com", "sky.com", "virginmedia.com", "ntlworld.com", "blueyonder.co.uk", "talktalk.net", "shaw.ca", "rogers.com", "sympatico.ca", "bigpond.com", "optusnet.com.au", "xtra.co.nz",
]);

// Role / functional mailbox local parts.
const ROLE_LOCALS = new Set([
  "admin", "administrator", "info", "support", "help", "helpdesk", "noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "sales", "postmaster", "hostmaster", "webmaster", "abuse", "billing", "accounts", "accounting", "hello", "hi", "contact", "team", "office", "mail", "email", "enquiries", "enquiry", "inquiries", "inquiry", "marketing", "press", "media", "pr", "news", "newsletter", "jobs", "careers", "hr", "recruiting", "legal", "privacy", "security", "compliance", "root", "sysadmin", "it", "tech", "dev", "developer", "ops", "devops", "service", "services", "customerservice", "customer-service", "customercare", "orders", "order", "shop", "store", "feedback", "subscribe", "unsubscribe", "list", "listserv", "mailer-daemon", "bounce", "bounces", "notifications", "notification", "alerts", "alert", "system", "test", "testing", "spam", "ftp", "www", "staff", "finance", "payments", "invoice", "invoices", "partners", "partner", "affiliates", "reception", "secretary", "ceo", "cto", "cfo", "founders", "everyone", "all",
]);

// Well-known disposable / temporary email domains.
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "mailinator.net", "mailinator2.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamail.biz", "guerrillamail.de", "guerrillamail.info", "guerrillamailblock.com", "grr.la", "sharklasers.com", "spam4.me", "pokemail.net",
  "10minutemail.com", "10minutemail.net", "10minutemail.org", "10minutemail.de", "10minemail.com", "10minutemail.co.uk", "10minutemail.be", "10minutemail.co.za", "10minutemail.cf", "10minutemail.ga", "10minutemail.gq", "10minutemail.ml", "20minutemail.com", "20minutemail.it", "30minutemail.com", "60minutemail.com",
  "tempmail.com", "tempmail.net", "tempmail.org", "tempmail.de", "tempmail.us", "tempmail.io", "tempmail.plus", "tempmail.ninja", "temp-mail.org", "temp-mail.io", "temp-mail.ru", "temp-mail.com", "tempmailo.com", "tempmailaddress.com", "tempemail.com", "tempemail.net", "tempemail.co", "tempe-mail.com", "tempinbox.com", "tempinbox.co.uk", "tempr.email", "tempmail.dev", "tempmails.net", "tmpmail.net", "tmpmail.org", "tmpeml.com", "tmpbox.net", "tmail.ws", "tmails.net",
  "yopmail.com", "yopmail.fr", "yopmail.net", "cool.fr.nf", "jetable.fr.nf", "nospam.ze.tc", "nomail.xl.cx", "mega.zik.dj", "speed.1s.fr", "courriel.fr.nf", "moncourrier.fr.nf", "monemail.fr.nf", "monmail.fr.nf",
  "trashmail.com", "trashmail.net", "trashmail.org", "trashmail.de", "trashmail.me", "trashmail.io", "trashmail.at", "trashmail.xyz", "trash-mail.com", "trash-mail.at", "trash-mail.de", "trashymail.com", "trashymail.net", "trashemail.de", "trash2009.com", "trashdevil.com", "trashdevil.de",
  "getnada.com", "nada.email", "nada.ltd", "getairmail.com", "airmail.cc", "dispostable.com", "discard.email", "discardmail.com", "discardmail.de", "spamgourmet.com", "spamgourmet.net", "spamgourmet.org", "spamex.com", "spamfree24.org", "spamfree24.de", "spamhereplease.com", "spambox.us", "spam.la", "spamavert.com", "spamcorptastic.com", "spamday.com", "spamherelots.com", "spaml.com", "spamobox.com", "spamspot.com", "spamstack.net", "spamthis.co.uk", "spamthisplease.com",
  "maildrop.cc", "mailnesia.com", "mailcatch.com", "mailexpire.com", "mailforspam.com", "mailfreeonline.com", "mailguard.me", "mailhazard.com", "mailhz.me", "mailimate.com", "mailin8r.com", "mailinater.com", "mailmetrash.com", "mailmoat.com", "mailnull.com", "mailpick.biz", "mailrock.biz", "mailscrap.com", "mailshell.com", "mailsiphon.com", "mailslapping.com", "mailslite.com", "mailtemp.info", "mailtome.de", "mailtothis.com", "mailtrash.net", "mailzilla.com", "mailzilla.org", "mailzilla.orgmbx.cc", "mailsac.com", "mailtemp.net", "mail-temp.com", "mail-temporaire.fr", "mail.by", "mailbox.in.ua", "mailbucket.org", "mailcat.biz", "mailchop.com", "maileater.com", "maileimer.de", "mailita.tk", "mailjunk.cf", "mailjunk.ga", "mailjunk.gq", "mailjunk.ml", "mailjunk.tk",
  "throwawaymail.com", "throwam.com", "throwawayemailaddress.com", "throam.com", "fakeinbox.com", "fakeinbox.net", "fakemail.fr", "fakemailgenerator.com", "fakemailz.com", "fakemail.net", "fake-mail.ml", "fake-box.com", "burnermail.io", "burnermail.com", "burpcollaborator.net", "disposable.com", "disposableemailaddresses.com", "disposableinbox.com", "disposableaddress.com", "dispose.it", "disposeamail.com", "dodgeit.com", "dodgit.com", "dodgit.org", "dontreg.com", "dontsendmespam.de", "drdrb.com", "drdrb.net", "dropmail.me", "dumpmail.de", "dumpyemail.com", "e4ward.com", "emailgo.de", "emailias.com", "emailigo.de", "emailinfive.com", "emaillime.com", "emailmiser.com", "emailsensei.com", "emailtemporanea.com", "emailtemporanea.net", "emailtemporar.ro", "emailtemporario.com.br", "emailthe.net", "emailtmp.com", "emailto.de", "emailwarden.com", "emailx.at.hm", "emailxfer.com", "emeil.in", "emeil.ir", "emz.net", "ephemail.net", "etranquil.com", "etranquil.net", "etranquil.org", "explodemail.com", "express.net.ua", "eyepaste.com", "fansworldwide.de", "fantasymail.de", "fightallspam.com", "filzmail.com", "fixmail.tk", "fizmail.com", "fleckens.hu", "frapbot.com", "freemail.ms", "freemails.cf", "freemails.ga", "freemails.ml", "front14.org", "fuckingduh.com", "fudgerub.com", "garliclife.com", "gelitik.in", "getonemail.com", "getonemail.net", "ghosttexter.de", "giantmail.de", "girlsundertheinfluence.com", "gishpuppy.com", "gowikibooks.com", "gowikicampus.com", "gowikicars.com", "gowikifilms.com", "gowikigames.com", "gowikimusic.com", "gowikinetwork.com", "gowikitravel.com", "gowikitv.com", "great-host.in", "greensloth.com", "gsrv.co.uk", "guerillamail.biz", "guerillamail.com", "guerillamail.net", "guerillamail.org", "h8s.org", "haltospam.com", "harakirimail.com", "hat-geld.de", "hatespam.org", "hidemail.de", "hidzz.com", "hmamail.com", "hochsitze.com", "hotpop.com", "hulapla.de", "ieatspam.eu", "ieatspam.info", "ieh-mail.de", "ihateyoualot.info", "iheartspam.org", "imails.info", "inbax.tk", "inbox.si", "inboxalias.com", "inboxbear.com", "inboxclean.com", "inboxclean.org", "inboxkitten.com", "incognitomail.com", "incognitomail.net", "incognitomail.org", "insorg-mail.info", "instant-mail.de", "ip6.li", "ipoo.org", "irish2me.com", "iwi.net", "jetable.com", "jetable.net", "jetable.org", "jnxjn.com", "jourrapide.com", "jsrsolutions.com", "junk1e.com", "kasmail.com", "kaspop.com", "keepmymail.com", "killmail.com", "killmail.net", "kir.ch.tc", "klassmaster.com", "klassmaster.net", "klzlk.com", "koszmail.pl", "kurzepost.de", "lawlita.com", "letthemeatspam.com", "lhsdv.com", "lifebyfood.com", "link2mail.net", "litedrop.com", "lol.ovpn.to", "lolfreak.net", "lookugly.com", "lortemail.dk", "lr78.com", "lroid.com", "lukop.dk", "m21.cc", "m4ilweb.info", "maboard.com", "mail-filter.com", "mail-temporaire.com", "mail.mezimages.net", "mail2rss.org", "mail333.com", "mail4trash.com", "mailbidon.com", "mailbiz.biz", "mailblocks.com",
  "mohmal.com", "mohmal.im", "mohmal.in", "mohmal.tech", "moakt.com", "moakt.ws", "moakt.cc", "tmpmail.co", "disbox.net", "disbox.org", "emailondeck.com", "emailfake.com", "crazymailing.com", "mintemail.com", "mytemp.email", "mytrashmail.com", "mytrashmailer.com", "mt2009.com", "mt2014.com", "mt2015.com", "neverbox.com", "nomail2me.com", "nospamfor.us", "nospammail.net", "notmailinator.com", "nowmymail.com", "objectmail.com", "obobbo.com", "odnorazovoe.ru", "oneoffemail.com", "onewaymail.com", "online.ms", "opayq.com", "ordinaryamerican.net", "otherinbox.com", "ovpn.to", "owlpic.com", "pancakemail.com", "pjjkp.com", "plexolan.de", "poofy.org", "pookmail.com", "privacy.net", "privy-mail.com", "proxymail.eu", "prtnx.com", "punkass.com", "putthisinyourspamdatabase.com", "quickinbox.com", "quickmail.nl", "rcpt.at", "reallymymail.com", "realtyalerts.ca", "recode.me", "recursor.net", "regbypass.com", "rejectmail.com", "rhyta.com", "rmqkr.net", "royal.net", "rppkn.com", "rtrtr.com", "s0ny.net", "safe-mail.net", "safersignup.de", "safetymail.info", "safetypost.de", "sandelf.de", "saynotospams.com", "schafmail.de", "selfdestructingmail.com", "sendspamhere.com", "shieldedmail.com", "shiftmail.com", "shitmail.me", "shitmail.org", "shortmail.net", "sibmail.com", "skeefmail.com", "slaskpost.se", "slopsbox.com", "smashmail.de", "smellfear.com", "snakemail.com", "sneakemail.com", "sneakmail.de", "snkmail.com", "sofimail.com", "sogetthis.com", "soodonims.com", "spamail.de", "spambob.com", "spambob.net", "spambob.org", "spambog.com", "spambog.de", "spambog.ru", "spamcannon.com", "spamcannon.net", "spamcero.com", "spamcon.org", "spamcowboy.com", "spamcowboy.net", "spamcowboy.org", "spamdecoy.net", "spamfighter.cf", "spamfighter.ga", "spamfighter.gq", "spamfighter.ml", "spamfighter.tk", "spamhole.com", "spamify.com", "spaminator.de", "spamkill.info", "spamlot.net", "spammotel.com", "spamoff.de", "spamslicer.com", "spamsphere.com", "spamtrail.com", "spamtroll.net", "speed.1s.fr", "squizzy.de", "sry.li", "ssoia.com", "startkeys.com", "stinkefinger.net", "stop-my-spam.com", "stuffmail.de", "super-auswahl.de", "supergreatmail.com", "supermailer.jp", "superrito.com", "superstachel.de", "suremail.info", "sweetxxx.de", "tafmail.com", "tagyourself.com", "talkinator.com", "tapchicuoihoi.com", "teewars.org", "teleworm.com", "teleworm.us", "temp-mail.de", "tempalias.com", "tempe-mail.com", "tempemail.biz", "tempinbox.com", "tempmail.eu", "tempmail.it", "tempmail2.com", "tempmaildemo.com", "tempmailer.com", "tempmailer.de", "tempomail.fr", "temporarily.de", "temporarioemail.com.br", "temporaryemail.net", "temporaryemail.us", "temporaryforwarding.com", "temporaryinbox.com", "temporarymailaddress.com", "tempsky.com", "tempthe.net", "tempymail.com", "thanksnospam.info", "thankyou2010.com", "thc.st", "thelimestones.com", "thisisnotmyrealemail.com", "thismail.net", "throwawaymail.com", "tilien.com", "tittbit.in", "tizi.com", "tmailinator.com", "toiea.com", "topranklist.de", "tradermail.info", "trbvm.com", "trialmail.de", "trillianpro.com", "turual.com", "twinmail.de", "tyldd.com", "uggsrock.com", "umail.net", "upliftnow.com", "uplipht.com", "uroid.com", "us.af", "venompen.com", "veryrealemail.com", "viditag.com", "viewcastmedia.com", "viewcastmedia.net", "viewcastmedia.org", "vomoto.com", "vpn.st", "vsimcard.com", "vubby.com", "wasteland.rfc822.org", "webemail.me", "webm4il.info", "weg-werf-email.de", "wegwerf-emails.de", "wegwerfadresse.de", "wegwerfemail.com", "wegwerfemail.de", "wegwerfmail.de", "wegwerfmail.info", "wegwerfmail.net", "wegwerfmail.org", "wh4f.org", "whyspam.me", "willhackforfood.biz", "willselfdestruct.com", "winemaven.info", "wronghead.com", "wuzup.net", "wuzupmail.net", "www.e4ward.com", "www.gishpuppy.com", "www.mailinator.com", "wwwnew.eu", "x.ip6.li", "xagloo.com", "xemaps.com", "xents.com", "xmaily.com", "xoxy.net", "yapped.net", "yeah.net", "yep.it", "yogamaven.com", "yopmail.gq", "yourdomain.com", "ypmail.webarnak.fr.eu.org", "yuurok.com", "z1p.biz", "za.com", "zehnminuten.de", "zehnminutenmail.de", "zetmail.com", "zippymail.info", "zoemail.net", "zoemail.org", "zomg.info", "zippymail.info", "33mail.com", "anonbox.net", "anonymbox.com", "antichef.com", "antichef.net", "antispam.de", "armyspy.com", "beefmilk.com", "binkmail.com", "bobmail.info", "bofthew.com", "boun.cr", "bouncr.com", "brefmail.com", "bsnow.net", "bugmenot.com", "bumpymail.com", "cust.in", "cuvox.de", "dayrep.com", "deadaddress.com", "deadspam.com", "despam.it", "despammed.com", "devnullmail.com", "dfgh.net", "digitalsanctuary.com", "dingbone.com", "dayrep.com", "einrot.com", "emailtemporario.com.br", "ero-tube.org", "evopo.com", "fakeinformation.com", "filzmail.com", "guerrillamail.com", "gustr.com", "imgof.com", "jourrapide.com", "kasmail.com", "mailnesia.com", "mailzi.ru", "mvrht.com", "nwldx.com", "sharklasers.com", "shitaway.tk", "superrito.com", "tempail.com", "tempmail.space", "luxusmail.org", "cuvox.de", "edv.to", "ezstest.com", "fakemail.io", "internetoftags.com", "mailto.plus", "fexpost.com", "fexbox.org", "mailbox.in.ua", "rover.info", "chitthi.in", "fextemp.com", "any.pink", "merepost.com", "mail7.io", "emlhub.com", "emlpro.com", "emltmp.com", "inboxes.com", "inboxhub.net", "guerrillamail.ch", "cmail.club", "cmail.net", "emailtemp.org", "tempmailx.com", "tmpemail.com", "tmpemails.com", "tmpmailtor.com", "temporary-mail.net", "generator.email", "mailgen.biz", "mailgen.fun", "mailgen.info", "mailgen.pro", "mailgen.pw", "mailgen.xyz", "minutemail.com", "tempsky.co", "tempmail.lol", "yopmail.ml", "gmailvn.net", "fakermail.com", "altmails.com", "crazymailing.com", "disposablemail.com", "ethereal.email", "bupmail.com", "mailpoof.com", "haribu.net", "dropjar.com", "getmails.eu", "inboxkitten.com", "spamdrain.net", "mailsac.com", "tempmail.cn", "guerrillamail.com",
]);

// ---------- helpers ----------
const b64e = (obj) => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const b64d = (str) => {
  const bin = atob(str);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
};
const b64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE", ...headers },
  });

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => deepEqual(a[key], b[key]));
}

// ---------- CDP auth (Ed25519 or EC P-256 key), mirrors @coinbase/cdp-sdk generateJwt ----------
async function cdpJwt(env, method, host, path) {
  const secret = String(env.CDP_API_KEY_SECRET).trim().replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = [...nonceBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const claims = { sub: env.CDP_API_KEY_ID, iss: "cdp", uris: [`${method} ${host}${path}`], iat: now, nbf: now, exp: now + 120 };
  let alg, key, signParams;
  if (secret.includes("BEGIN")) {
    // EC key in PEM (PKCS#8 or SEC1 "EC PRIVATE KEY")
    const body = secret.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    let der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    if (secret.includes("BEGIN EC PRIVATE KEY")) der = sec1ToPkcs8(der);
    key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    alg = "ES256";
    signParams = { name: "ECDSA", hash: "SHA-256" };
  } else {
    const raw = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
    if (raw.length !== 64) throw new Error("CDP_API_KEY_SECRET is not a valid Ed25519 key");
    key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: b64url(raw.slice(0, 32)), x: b64url(raw.slice(32)) }, { name: "Ed25519" }, false, ["sign"]);
    alg = "EdDSA";
    signParams = { name: "Ed25519" };
  }
  const header = { alg, kid: env.CDP_API_KEY_ID, typ: "JWT", nonce };
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const input = `${enc(header)}.${enc(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign(signParams, key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}
function der(tag, content) {
  const n = content.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  return Uint8Array.from([tag, ...len, ...content]);
}
function sec1ToPkcs8(sec1) {
  // PKCS#8 = SEQUENCE { INTEGER 0, SEQUENCE { id-ecPublicKey, prime256v1 }, OCTET STRING sec1 }
  const algId = Uint8Array.from([0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
  return der(0x30, [0x02, 0x01, 0x00, ...algId, ...der(0x04, sec1)]);
}

function facilitator(env) {
  const useCdp = env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET;
  const base = useCdp ? CDP_URL : PAYAI_URL;
  const u = new URL(base);
  return {
    name: useCdp ? "cdp" : "payai",
    async call(op, body) {
      const headers = { "Content-Type": "application/json" };
      if (useCdp) headers.Authorization = `Bearer ${await cdpJwt(env, "POST", u.host, `${u.pathname.replace(/\/$/, "")}/${op}`)}`;
      const res = await fetch(`${base}/${op}`, { method: "POST", headers, body: JSON.stringify(body) });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
      return { ok: res.ok, status: res.status, data };
    },
  };
}


// ---------- email analysis ----------
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LOCAL_DOT_ATOM = new RegExp(`^${ATOM}(\\.${ATOM})*$`);
const LOCAL_QUOTED = /^"(?:[^"\\\r\n]|\\[^\r\n])*"$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

// Practical RFC 5322 subset: dot-atom or quoted-string local part (<= 64 chars), ASCII hostname
// domain with at least two labels and an alphabetic TLD, total length <= 254.
function parseEmail(raw) {
  const out = { valid_syntax: false, local: "", domain: "" };
  if (typeof raw !== "string") return out;
  const s = raw.trim();
  if (!s || s.length > 254 || /[\u0000-\u001f\u007f]/.test(s)) return out;
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return out;
  const local = s.slice(0, at), domain = s.slice(at + 1);
  if (local.length > 64) return out;
  if (!LOCAL_DOT_ATOM.test(local) && !LOCAL_QUOTED.test(local)) return out;
  if (domain.length > 253 || /[^A-Za-z0-9.-]/.test(domain)) return out;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return out;
  if (!/^[A-Za-z]{2,63}$/.test(labels[labels.length - 1])) return out;
  return { valid_syntax: true, local, domain: domain.toLowerCase() };
}

// Optimal string alignment distance (Levenshtein + adjacent transposition).
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => { const r = new Array(n + 1).fill(0); r[0] = i; return r; });
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

// Returns { domain, distance } for the closest top provider within distance 2, or null.
function closestProvider(domain) {
  if (TOP_PROVIDERS.includes(domain) || FREE_PROVIDERS.has(domain) || DISPOSABLE_DOMAINS.has(domain)) return null;
  let best = null;
  for (const p of TOP_PROVIDERS) {
    if (Math.abs(p.length - domain.length) > 2) continue;
    const dist = editDistance(domain, p);
    if (dist <= 2 && (!best || dist < best.distance)) best = { domain: p, distance: dist };
  }
  return best;
}

const PLUS_TAG_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "protonmail.com", "proton.me", "pm.me", "fastmail.com", "fastmail.fm", "zoho.com", "hey.com"]);
function normalize(local, domain) {
  let l = local.toLowerCase(), d = domain;
  if (d === "googlemail.com") d = "gmail.com";
  if (d === "gmail.com") l = l.replace(/\./g, "");
  if (PLUS_TAG_DOMAINS.has(d)) l = l.replace(/\+.*$/, "");
  return `${l}@${d}`;
}

function isRole(local) {
  const l = local.toLowerCase().replace(/^"|"$/g, "");
  if (ROLE_LOCALS.has(l)) return true;
  return /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon)/.test(l);
}

// ---------- DNS over HTTPS ----------
async function dohQuery(name, type, ctx) {
  const u = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`;
  const cache = typeof caches !== "undefined" && caches && caches.default ? caches.default : null;
  if (cache) {
    try { const hit = await cache.match(u); if (hit) return await hit.json(); } catch {}
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DOH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(u, { headers: { accept: "application/dns-json", "User-Agent": USER_AGENT }, signal: ac.signal });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`DNS resolver responded ${res.status}`);
  const data = await res.json();
  if (typeof data.Status !== "number") throw new Error("DNS resolver returned an unexpected response");
  if (data.Status !== 0 && data.Status !== 3) throw new Error(`DNS resolver returned RCODE ${data.Status} for ${name}`);
  if (cache) {
    const ttl = Math.max(60, Math.min(3600, ...(data.Answer || []).map((a) => Number(a.TTL) || 300)));
    const put = cache.put(u, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } })).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(put);
  }
  return data;
}

const answers = (data, type) => (Array.isArray(data.Answer) ? data.Answer.filter((a) => a.type === type && typeof a.data === "string") : []);
// Returns { status: "mx"|"null_mx"|"a"|"aaaa"|"nxdomain"|"none", mx_hosts: [...] }
async function lookupDomain(domain, ctx) {
  const mx = await dohQuery(domain, "MX", ctx);
  if (mx.Status === 3) return { status: "nxdomain", mx_hosts: [] };
  const recs = answers(mx, 15).map((a) => { const [pri, host] = a.data.trim().split(/\s+/); return { pri: Number(pri) || 0, host: (host || "").replace(/\.$/, "").toLowerCase() }; });
  if (recs.length) {
    if (recs.every((r) => r.host === "" || r.host === ".")) return { status: "null_mx", mx_hosts: [] }; // RFC 7505: domain refuses mail
    recs.sort((x, y) => x.pri - y.pri);
    return { status: "mx", mx_hosts: [...new Set(recs.filter((r) => r.host).map((r) => r.host))].slice(0, MAX_MX_HOSTS) };
  }
  const a = await dohQuery(domain, "A", ctx);
  if (answers(a, 1).length) return { status: "a", mx_hosts: [] };
  const aaaa = await dohQuery(domain, "AAAA", ctx);
  if (answers(aaaa, 28).length) return { status: "aaaa", mx_hosts: [] };
  return { status: "none", mx_hosts: [] };
}

// ---------- params ----------
async function readParams(request, url) {
  const p = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    try { const b = await request.clone().json(); if (b && typeof b === "object" && !Array.isArray(b)) Object.assign(p, b); } catch {}
  }
  return { email: p.email, emails: p.emails };
}

// Returns { error } or { emails: [..] }
function validate(q) {
  const bad = (msg) => ({ error: `${msg} (no payment was taken)` });
  let list = [];
  if (q.emails !== undefined && q.emails !== null && q.emails !== "") {
    if (typeof q.emails === "string") list = q.emails.split(",");
    else if (Array.isArray(q.emails)) list = q.emails;
    else return bad("emails must be an array of strings (or a comma-separated string)");
  }
  if (q.email !== undefined && q.email !== null && q.email !== "") {
    if (typeof q.email !== "string") return bad("email must be a string");
    list.unshift(q.email);
  }
  if (!list.length) return bad("Missing required parameter: email (or emails: [...])");
  if (list.length > MAX_EMAILS) return bad(`Too many addresses: at most ${MAX_EMAILS} per request`);
  const emails = [];
  for (const e of list) {
    if (typeof e !== "string") return bad("Every entry in emails must be a string");
    const s = e.trim();
    if (!s) return bad("Empty email address in request");
    if (s.length > 320) return bad("Email address too long (max 320 characters)");
    emails.push(s);
  }
  return { emails };
}

// Resolves every syntactically valid domain once. Throws on DNS resolver failure.
async function loadDns(q, ctx) {
  const domains = [...new Set(q.emails.map((e) => parseEmail(e)).filter((p) => p.valid_syntax).map((p) => p.domain))];
  const results = await Promise.all(domains.map((d) => lookupDomain(d, ctx)));
  const dns = {};
  domains.forEach((d, i) => { dns[d] = results[i]; });
  return dns;
}

function analyze(email, dns) {
  const p = parseEmail(email);
  const reasons = [];
  const r = { email, normalized_email: null, valid_syntax: p.valid_syntax, domain: p.domain || null, has_mx: false, mx_hosts: [], disposable: false, role: false, free_provider: false, suggestion: null, risk: "high", reasons };
  if (!p.valid_syntax) { reasons.push("invalid_syntax"); return r; }
  r.normalized_email = normalize(p.local, p.domain);
  const d = dns[p.domain] || { status: "none", mx_hosts: [] };
  r.has_mx = d.status === "mx";
  r.mx_hosts = d.mx_hosts;
  r.disposable = DISPOSABLE_DOMAINS.has(p.domain);
  r.role = isRole(p.local);
  r.free_provider = FREE_PROVIDERS.has(p.domain);
  const close = closestProvider(p.domain);
  if (close && (close.distance === 1 || !r.has_mx)) r.suggestion = `${p.local.toLowerCase()}@${close.domain}`;

  let risk = "low";
  const bump = (level, reason) => { reasons.push(reason); if (level === "high" || (level === "medium" && risk === "low")) risk = level; };
  if (d.status === "nxdomain") bump("high", "domain_not_found");
  else if (d.status === "null_mx") bump("high", "null_mx_domain_refuses_mail");
  else if (d.status === "none") bump("high", "no_mx_or_address_records");
  else if (d.status === "a" || d.status === "aaaa") bump("medium", `no_mx_fallback_${d.status}`);
  if (r.disposable) bump("high", "disposable_domain");
  if (r.suggestion) bump("medium", "possible_typo");
  if (r.role) bump("medium", "role_address");
  if (r.free_provider) reasons.push("free_provider");
  r.risk = risk;
  return r;
}

// Returns { status, body } — status !== 200 means do not settle.
function compute(q, dns) {
  const results = q.emails.map((e) => analyze(e, dns));
  return { status: 200, body: { count: results.length, results, resolver: "cloudflare-dns.com (DNS over HTTPS)", note: "Checks are syntax, DNS (MX/A/AAAA), disposable/role/free-provider lists and typo heuristics. No SMTP mailbox probing is performed; has_mx=true means the domain accepts mail, not that the mailbox exists." } };
}

// ---------- x402 ----------
function requirements(env) {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: PRICE_ATOMIC,
    asset: USDC_BASE,
    payTo: env.PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
}
const EXAMPLE_OUTPUT = {
  count: 1,
  results: [
    {
      email: "John.Doe+news@gmail.com",
      normalized_email: "johndoe@gmail.com",
      valid_syntax: true,
      domain: "gmail.com",
      has_mx: true,
      mx_hosts: ["gmail-smtp-in.l.google.com", "alt1.gmail-smtp-in.l.google.com", "alt2.gmail-smtp-in.l.google.com", "alt3.gmail-smtp-in.l.google.com", "alt4.gmail-smtp-in.l.google.com"],
      disposable: false,
      role: false,
      free_provider: true,
      suggestion: null,
      risk: "low",
      reasons: ["free_provider"],
    },
  ],
  resolver: "cloudflare-dns.com (DNS over HTTPS)",
  note: "Checks are syntax, DNS (MX/A/AAAA), disposable/role/free-provider lists and typo heuristics. No SMTP mailbox probing is performed; has_mx=true means the domain accepts mail, not that the mailbox exists.",
};
function paymentRequired(env, url, error) {
  const resourceUrl = `${url.origin}/verify`;
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: DESCRIPTION, mimeType: "application/json" },
    accepts: [requirements(env)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: { email: "John.Doe+news@gmail.com" } },
          output: { type: "json", example: EXAMPLE_OUTPUT },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string", enum: ["GET", "HEAD", "DELETE"] },
                queryParams: {
                  type: "object",
                  properties: {
                    email: { type: "string", description: "Email address to check, e.g. john@example.com" },
                    emails: { type: "string", description: "Optional comma-separated list of up to 20 addresses (same price as one)" },
                  },
                  required: ["email"],
                },
              },
              required: ["type", "method"],
              additionalProperties: false,
            },
            output: {
              type: "object",
              properties: { type: { type: "string" }, example: { type: "object" } },
              required: ["type"],
            },
          },
          required: ["input"],
        },
      },
    },
  };
}
function send402(env, url, error) {
  const pr = paymentRequired(env, url, error);
  return json(pr, 402, { "PAYMENT-REQUIRED": b64e(pr) });
}

function openapi(origin) {
  const params = {
    type: "object",
    properties: {
      email: { type: "string", description: "Email address to check, e.g. 'john@example.com'. Either email or emails is required." },
      emails: { type: "array", items: { type: "string" }, maxItems: MAX_EMAILS, description: "Up to 20 addresses checked in one request for the same price (GET: comma-separated string)" },
    },
  };
  const result = {
    type: "object",
    properties: {
      email: { type: "string", description: "Address as submitted" },
      normalized_email: { type: ["string", "null"], description: "Lowercased; Gmail dots and +tags removed, googlemail.com mapped to gmail.com" },
      valid_syntax: { type: "boolean", description: "Passes the RFC 5322 practical subset" },
      domain: { type: ["string", "null"] },
      has_mx: { type: "boolean", description: "Domain publishes MX records" },
      mx_hosts: { type: "array", items: { type: "string" }, description: "Up to 5 MX hosts by priority" },
      disposable: { type: "boolean", description: "Domain is a known disposable/temporary mail service" },
      role: { type: "boolean", description: "Role or functional mailbox (admin@, info@, support@, noreply@ ...)" },
      free_provider: { type: "boolean", description: "Free consumer mailbox provider (Gmail, Yahoo, Outlook ...)" },
      suggestion: { type: ["string", "null"], description: "Likely intended address when the domain looks like a typo of a major provider" },
      risk: { type: "string", enum: ["low", "medium", "high"] },
      reasons: { type: "array", items: { type: "string" }, description: "Machine-readable reason codes behind the risk score" },
    },
    required: ["email", "normalized_email", "valid_syntax", "domain", "has_mx", "mx_hosts", "disposable", "role", "free_provider", "suggestion", "risk", "reasons"],
  };
  const out = {
    type: "object",
    properties: { count: { type: "integer" }, results: { type: "array", items: result }, resolver: { type: "string" }, note: { type: "string" } },
    required: ["count", "results"],
  };
  const op = (method) => ({
    operationId: method === "post" ? "verifyEmailPost" : "verifyEmail",
    summary: "Verify one email address or up to 20 at once: syntax, MX records, disposable, role, free provider, typo suggestion, normalized form and risk score",
    tags: ["Email", "Validation", "Data Quality"],
    "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.001000" }, protocols: [{ x402: {} }] },
    ...(method === "post"
      ? { requestBody: { required: true, content: { "application/json": { schema: params } } } }
      : { parameters: Object.entries(params.properties).map(([n, sch]) => ({ name: n, in: "query", required: false, schema: { type: "string" }, description: sch.description })) }),
    responses: {
      200: { description: "Verification results", content: { "application/json": { schema: out } } },
      400: { description: "Missing or malformed input, or more than 20 addresses (no charge)" },
      402: { description: "Payment Required" },
      413: { description: "Request too large (no charge)" },
      502: { description: "DNS resolver temporarily unavailable (no charge)" },
    },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": "Use GET /verify?email=john@example.com (or POST /verify with JSON {email} or {emails:[...]} for up to 20 addresses) to check an email address before you send to it, store it or trust it. Each result reports valid_syntax, has_mx with mx_hosts, disposable, role, free_provider, a typo suggestion (gmial.com -> gmail.com), normalized_email and a risk score of low/medium/high with reason codes. Costs $0.001 USDC on Base per request via x402, whether you send 1 or 20 addresses. Invalid addresses are returned as results (valid_syntax=false), not errors. No SMTP mailbox probing is done, so has_mx=true means the domain accepts mail, not that the specific mailbox exists.",
    },
    servers: [{ url: origin }],
    paths: { "/verify": { get: op("get"), post: op("post") } },
  };
}

export default {
  async fetch(request, env0, ctx) {
    const env = { ...env0, PAY_TO: (env0 && env0.PAY_TO) || DEFAULT_PAY_TO };
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: SERVICE,
        description: DESCRIPTION,
        openapi: `${url.origin}/openapi.json`,
        endpoint: `${url.origin}/verify?email=john@example.com  (or POST JSON {email} / {emails:[...up to 20]})`,
        price: "$0.001 USDC on Base per request (x402), 1 to 20 addresses per request",
        checks: ["syntax (RFC 5322 subset)", "MX records via DNS over HTTPS (A/AAAA fallback)", "disposable domain list", "role address", "free-mail provider", "typo suggestion", "normalized form", "risk score"],
        resolver: "cloudflare-dns.com",
        configured: Boolean(env.PAY_TO),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    if (url.pathname !== "/verify") return json({ error: "Not found. Use /verify?email=john@example.com" }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, 405);
    const clen = Number(request.headers.get("content-length") || 0);
    if (url.search.length > 8192 || clen > MAX_BODY_BYTES) return json({ error: `Request too large: at most ${MAX_EMAILS} addresses, ${MAX_BODY_BYTES} bytes (no payment was taken)` }, 413);

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, "PAYMENT-SIGNATURE header is required");
    if (request.method === "POST") {
      const raw = await request.clone().text();
      if (raw.length > MAX_BODY_BYTES) return json({ error: `Request too large: at most ${MAX_EMAILS} addresses, ${MAX_BODY_BYTES} bytes (no payment was taken)` }, 413);
    }
    const q = validate(await readParams(request, url));
    if (q.error) return json(q, 400);

    let payload;
    try { payload = b64d(header); } catch { return json({ error: "Invalid payment payload" }, 400); }
    const reqs = requirements(env);
    if (payload.x402Version !== 2 || !deepEqual(payload.accepted, reqs)) return send402(env, url, "No matching payment requirements found");

    const fac = facilitator(env);
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs };
    let v;
    try { v = await fac.call("verify", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!v.ok || !v.data.isValid) return send402(env, url, v.data.invalidReason || v.data.error || `verify failed (${v.status})`);

    let dns;
    try { dns = await loadDns(q, ctx); } catch (e) { return json({ error: "DNS resolver is temporarily unavailable; no payment was taken. Please retry.", detail: String(e.message || e) }, 502); }
    const result = compute(q, dns);
    if (result.status !== 200) return json(result.body, result.status);

    let s;
    try { s = await fac.call("settle", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!s.ok || !s.data.success) {
      const fail = { success: false, errorReason: s.data.errorReason || s.data.error || `settle failed (${s.status})`, transaction: "", network: NETWORK, payer: s.data.payer || v.data.payer };
      return json({}, 402, { "PAYMENT-RESPONSE": b64e(fail) });
    }
    const receipt = { success: true, transaction: s.data.transaction, network: s.data.network || NETWORK, payer: s.data.payer || v.data.payer };
    return json(result.body, 200, { "PAYMENT-RESPONSE": b64e(receipt) });
  },
};
