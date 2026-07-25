# Chronologie de lot et préfixes par appareil — `processImageFile` (Metapurge)

Cible : `src/lib/imageProcessor.ts`.

## 0. Ce que fait le code aujourd'hui

```
FileReader → dataURL → Image → canvas.drawImage → toDataURL('image/jpeg', 0.95)
   → piexif.remove()  ─── mode 'strip' → resolve(Blob)
   → mode 'spoof' : dump 0th/Exif/GPS → piexif.insert() → resolve(Blob)
```

Le temps est tiré ligne 137-141 :

```js
const now = new Date();
now.setDate(now.getDate() - Math.floor(Math.random() * 14));
```

Soit un recul de **0 à 13 jours au hasard, indépendant pour chaque image**, l'heure de la journée restant
l'heure réelle du traitement. La chaîne formatée part à l'identique dans `DateTime`, `DateTimeOriginal` et
`DateTimeDigitized`.

Deux défauts que ce document corrige :

1. **Dispersion incohérente.** Dix images importées ensemble ressortent éparpillées sur deux semaines, mais
   toutes exactement à la même heure de la journée. C'est le contraire d'un vrai appareil : les vraies photos
   sont groupées en rafales de quelques minutes, séparées par des heures.
2. **Le timestamp est jeté.** `now` est une variable locale à la closure. La fonction résout un `Blob` nu :
   rien en aval ne peut connaître la date écrite, donc rien ne peut nommer le fichier en cohérence avec elle.

---

# Partie A — Chronologie du lot

## A.1 Modèle

Les images sont traitées **dans leur ordre d'import** et regroupées par **clusters de 3** — un cluster = une
rafale, l'utilisateur qui prend trois photos de la même scène.

- **Dans un cluster** : écart de **3 à 4 minutes** entre deux images consécutives.
- **Entre deux clusters** : écart de **4 à 6 heures**.
- L'étalement total est plafonné par une **fenêtre** qui dépend du nombre d'images.

```
 cluster 1              cluster 2              cluster 3
 ●--3min--●--4min--●    ●--3min--●--3min--●    ●--4min--●--3min--●
                    └──── 5h12 ────┘       └──── 4h48 ────┘
 └──────────────────── étalement total ≤ fenêtre ────────────────────┘
```

## A.2 Fenêtre diurne — contrainte dominante

Personne ne prend trois photos à 4 h du matin. **Aucun timestamp ne sort de la plage `10:23` – `21:46`**,
soit **683 minutes utiles par jour**. Les bornes sont volontairement des minutes non rondes : un lot qui
commence toujours à 10:00 pile est un motif détectable.

Un cluster dure ~7 min, il doit donc démarrer au plus tard à 21:39. Quand un lot ne tient pas dans une
journée, il passe au bloc diurne suivant — jamais dans la nuit.

## A.3 Répartition en blocs diurnes

Le volume ne détermine plus une durée mais un **nombre de journées** :

| Nombre d'images | Blocs diurnes | Clusters | Amplitude réelle |
|---|---|---|---|
| 1 – 9 | **1 jour** | 1 – 3 | ≤ 11 h 23 |
| 10 – 18 | **2 jours** | 4 – 6 | ≤ 35 h (une nuit traversée) |
| 19 et + | **3 jours** | 7 et + | ≤ 59 h (deux nuits traversées) |

Les clusters sont répartis équitablement : `perDay = ceil(nClusters / nDays)`.

Dans une journée, l'écart inter-cluster est tiré dans `[4h, 6h]`. Si `nGaps × 6h` dépasse le budget
disponible du jour, il est recalculé en `budget / nGaps`, plancher à **30 min** pour que deux rafales ne se
chevauchent jamais. Le budget vaut `683 min − intra − gigue de départ − 20 min de marge`.

Vérification aux bornes :

| N | Clusters | Jours | Clusters/jour | Écarts/jour | Résultat |
|---|---|---|---|---|---|
| 3 | 1 | 1 | 1 | 0 | une rafale isolée |
| 9 | 3 | 1 | 3 | 2 | resserré à ~5 h 11 |
| 12 | 4 | 2 | 2 | 1 | 4–6 h conservés |
| 18 | 6 | 2 | 3 | 2 | resserré à ~5 h 11 |
| 30 | 10 | 3 | 4 | 3 | resserré à ~3 h 27 |
| 60 | 20 | 3 | 7 | 6 | resserré à ~1 h 42 |

Le modèle se dégrade proprement : plus il y a d'images, plus les rafales se rapprochent dans la journée,
jamais l'inverse.

Le pseudo-code de A.6 a été exécuté sur 300 tirages pour chaque `N ∈ {1, 3, 6, 9, 12, 18, 19, 30, 60, 90…168}`.
Résultats : aucun timestamp hors de `10:23`–`21:46`, aucune inversion d'ordre, aucune date future, écart intra
minimum de 3 min exactement, et le nombre de dates civiles vaut bien 1 / 2 / 3 aux paliers prévus —
**jusqu'à 162 images**. À partir de ~165 le plancher de 30 min devient contraignant : c'est lui qui gagne et la
journée déborde de `21:46` (mesuré : 168 images → violations sur ~4 tirages sur 10). Limite documentée, pas un
cas d'usage réel ; si des lots de cette taille devaient exister, il faudrait passer à 4 blocs diurnes plutôt
que baisser le plancher.

## A.4 Ancrage

Les blocs diurnes sont posés à partir de `aujourd'hui − nDays − aléatoire(0 ou 1)` jours, à `10:23` plus une
gigue de 0 à 40 min. La dernière image tombe donc au plus tard **hier soir** : le lot est récent, jamais
horodaté le jour du traitement. L'ordre d'import est préservé en ordre chronologique croissant.

## A.5 Le point structurel : un planificateur de lot

`processImageFile` est appelée **par fichier** et ne sait rien du lot. Une chronologie ne peut pas se calculer
dans cette fonction. Il faut la sortir :

```js
// nouveau, exporté depuis imageProcessor.ts
buildBatchTimeline(count: number): Date[]

// ProcessOptions gagne un champ
interface ProcessOptions {
  mode: 'strip' | 'spoof';
  spoofDevice?: string;
  spoofLocation?: string;
  customLocation?: {...};
  timestamp?: Date;        // ← fourni par la chronologie du lot
}
```

L'appelant calcule la chronologie une fois, puis passe `timeline[i]` à chaque appel. Les lignes 137-138
disparaissent au profit de `const shot = options.timestamp ?? fallbackRandom()`, le fallback conservant
l'ancien comportement quand la fonction est appelée seule.

## A.6 Pseudo-code

```js
const MIN = 60_000, HOUR = 60 * MIN;
const DAY_START = 10 * 60 + 23;          // 10:23, en minutes
const DAY_END   = 21 * 60 + 46;          // 21:46
const USABLE    = DAY_END - DAY_START;   // 683 min

function buildBatchTimeline(count) {
  const nClusters = Math.ceil(count / 3);
  const nDays  = count <= 9 ? 1 : count <= 18 ? 2 : 3;
  const perDay = Math.ceil(nClusters / nDays);

  // rafales : 1 à 3 images, écarts intra de 3 à 4 min
  const clusters = [];
  for (let c = 0; c < nClusters; c++) {
    const size = Math.min(3, count - c * 3);
    clusters.push({
      size,
      gaps: Array.from({ length: size - 1 }, () => 3 * MIN + Math.random() * MIN),
    });
  }

  // ancrage : nDays blocs diurnes qui se terminent au plus tard hier soir
  const base = new Date();
  base.setDate(base.getDate() - nDays - Math.floor(Math.random() * 2));
  base.setHours(0, 0, 0, 0);

  const out = [];
  for (let d = 0; d < nDays; d++) {
    const dayClusters = clusters.slice(d * perDay, (d + 1) * perDay);
    if (!dayClusters.length) break;

    const intra  = dayClusters.reduce((s, c) => s + c.gaps.reduce((a, b) => a + b, 0), 0);
    const jitter = Math.random() * 40 * MIN;
    const budget = USABLE * MIN - intra - jitter - 20 * MIN;
    const nGaps  = dayClusters.length - 1;

    // 4-6 h nominal ; resserré si la journée ne peut pas l'absorber
    const gapFor = () =>
      nGaps * 6 * HOUR > budget
        ? Math.max(30 * MIN, budget / nGaps)
        : 4 * HOUR + Math.random() * 2 * HOUR;

    const day = new Date(base);
    day.setDate(day.getDate() + d);
    let cursor = day.getTime() + DAY_START * MIN + jitter;

    dayClusters.forEach((c, ci) => {
      for (let i = 0; i < c.size; i++) {
        out.push(new Date(cursor));
        if (i < c.size - 1) cursor += c.gaps[i];
      }
      if (ci < nGaps) cursor += gapFor();
    });
  }
  return out;
}
```

Le test de resserrement porte sur `6h`, pas `4h` : sinon un tirage haut dans `[4h, 6h]` peut faire déborder
une journée que la borne basse aurait tenue. Et parce que la branche resserrée rend `budget / nGaps`, la somme
des écarts d'une journée vaut exactement son budget — le débordement de `21:46` est structurellement exclu
tant que le plancher de 30 min n'est pas atteint.

## A.7 Écriture EXIF

`shot` remplace `now` dans le formatage existant, inchangé pour le reste :

```js
const dateStr = `${shot.getFullYear()}:${pad(shot.getMonth()+1)}:${pad(shot.getDate())} ` +
                `${pad(shot.getHours())}:${pad(shot.getMinutes())}:${pad(shot.getSeconds())}`;
```

Toujours les trois mêmes tags : `ImageIFD.DateTime`, `ExifIFD.DateTimeOriginal`, `ExifIFD.DateTimeDigitized`.

---

# Partie B — Préfixes par appareil

## B.1 Règle centrale

> Le `Date` de la chronologie est **le même objet** qui alimente l'EXIF et le nom de fichier.
> Aucun appel à l'horloge système au moment de nommer.

```
timeline[i] ──┬──► writeMetadata(EXIF)
              └──► buildFileName(device, timeline[i], i)
```

Un décalage entre le nom et `DateTimeOriginal` est le premier indice qu'un observateur remarque.

## B.2 Catalogue — les 5 profils réellement présents dans `SPOOF_DEVICES`

| Clé | Make / Model | Motif de nom | Exemple | Type |
|---|---|---|---|---|
| `iphone15` | Apple / iPhone 15 Pro Max | `IMG_%04d` | `IMG_4821.JPG` | compteur |
| `s25ultra` | samsung / SM-S938B | `%Y%m%d_%H%M%S` | `20260724_143012.jpg` | horodaté |
| `pixel8` | Google / Pixel 8 Pro | `PXL_%Y%m%d_%H%M%S%3f` | `PXL_20260724_143012123.jpg` | horodaté + ms |
| `sonyA7` | SONY / ILCE-7M3 | `DSC%05d` | `DSC04821.JPG` | compteur |
| `canonR5` | Canon / Canon EOS R5 | `IMG_%04d` | `IMG_4821.JPG` | compteur |

Casse : Apple, Sony et Canon écrivent en **majuscules** ; Samsung et Google en **minuscules**. La sortie
étant toujours du JPEG (contrainte du canvas), l'extension est `.JPG` ou `.jpg` selon la marque — pas de
`.HEIC`, qui mentirait sur le contenu réel du fichier.

## B.3 Deux familles face à la chronologie

**Horodatés** (`s25ultra`, `pixel8`) — la date du cluster apparaît directement dans le nom. Trois images
d'une même rafale donnent `20260724_143012`, `20260724_143318`, `20260724_143641` : trois minutes d'écart,
visibles, cohérentes avec l'EXIF.

**À compteur** (`iphone15`, `sonyA7`, `canonR5`) — pas de date dans le nom, la contrainte devient l'**ordre**.
La chronologie étant croissante par ordre d'import, l'index ne peut que croître. Voir B.4 pour le détail iOS.

## B.4 Le compteur `IMG_####` façon iOS

Un `i + 1` naïf produit `IMG_0001, IMG_0002, IMG_0003` — c'est le motif d'un appareil qui n'a jamais servi, et
la suite parfaitement contiguë est le détail qui trahit le lot généré. Le vrai comportement iOS :

**Le compteur est celui de la pellicule, pas celui du lot.** Il vit sur toute la durée de vie de l'appareil et
s'incrémente à chaque capture — photos, captures d'écran, images enregistrées. Valeur de départ tirée **une
fois par lot**, dans `[0800, 6500]` : sous ~200 on lit un téléphone neuf, au-delà de ~9500 on lit un compteur
au bord du bouclage. Les deux extrêmes sont rares dans la vraie vie, donc suspects.

**Contigu dans la rafale, avec un trou entre les rafales.** Trois photos prises en 3 minutes se suivent
(`IMG_3421`, `IMG_3422`, `IMG_3423`). Mais entre deux rafales séparées de cinq heures, un vrai utilisateur a
pris d'autres photos — celles qui ne sont pas dans ce lot. Le compteur doit donc **sauter** :

```
rafale 1 (11:04)   IMG_3421  IMG_3422  IMG_3423
                                   ↳ saut de 1 à 6
rafale 2 (16:12)   IMG_3427  IMG_3428  IMG_3429
                                   ↳ saut de 3 à 25 (changement de jour)
rafale 3 (12:38, J+1)  IMG_3441  IMG_3442  IMG_3443
```

Saut inter-rafale : `+1 + aléatoire(1…6)`. Saut au passage d'un jour : `+1 + aléatoire(3…25)`, une journée
entière de photos non incluses représentant davantage de clichés.

**Format strict** : toujours **4 chiffres complétés par des zéros** — `IMG_0847`, jamais `IMG_847`. Bouclage
`9999 → 0001`. `IMG_0000` n'existe pas et ne doit jamais sortir.

```js
function buildCounters(timeline) {
  let n = 800 + Math.floor(Math.random() * 5700);   // 0800-6500, une fois par lot
  const out = [];
  timeline.forEach((ts, i) => {
    if (i > 0) {
      const prev = timeline[i - 1];
      const sameCluster = ts - prev < 10 * MIN;
      const sameDay = ts.getDate() === prev.getDate();
      n += sameCluster ? 1
         : sameDay    ? 1 + 1 + Math.floor(Math.random() * 6)
         :              1 + 3 + Math.floor(Math.random() * 23);
    }
    if (n > 9999) n -= 9999;                        // bouclage, jamais 0000
    out.push(String(n).padStart(4, '0'));
  });
  return out;
}
```

`sonyA7` suit la même logique sur 5 chiffres (`DSC04821`), `canonR5` sur 4 (`IMG_4821`) — mêmes sauts, la
mécanique est identique dès qu'un compteur de pellicule est en jeu.

## B.5 Collisions

Deux images à la même seconde sont impossibles avec des écarts intra-cluster de 3 minutes, mais le garde-fou
reste utile si la fenêtre est un jour resserrée davantage : suffixe entre parenthèses façon Samsung
(`20260724_143012(1).jpg`), ou incrément des millisecondes pour le Pixel. Jamais de suffixe aléatoire
type `_a7f3` : aucun téléphone ne nomme comme ça. Le registre des noms émis est tenu au niveau du lot.

## B.6 Le nom doit sortir de la fonction

`processImageFile` résout un `Blob`, sans nom. Pour que le préfixe serve à quelque chose, la signature change :

```js
processImageFile(file, options) -> Promise<{ blob: Blob, fileName: string }>
```

Le `fileName` est construit à partir de `options.spoofDevice` et `options.timestamp`. En mode `strip`, pas de
profil d'appareil : on retombe sur un nom neutre `IMG_%Y%m%d_%H%M%S.jpg`, jamais le nom d'origine — qui, lui,
porte souvent la signature de l'appareil réel.

---

## Ordre d'exécution imposé

1. `buildBatchTimeline(files.length)` → `Date[]`, une fois pour le lot.
2. `buildCounters(timeline)` → `string[]`, une fois pour le lot (appareils à compteur).
3. Par image `i` : `processImageFile(files[i], { ...opts, timestamp: timeline[i], counter: counters[i] })`.
4. Dans la fonction : `shot = options.timestamp` → EXIF **et** `buildFileName`.
5. Résolution des collisions au niveau du lot.
6. Téléchargement sous le nom généré.

L'étape 4 doit consommer la même valeur pour les deux sorties. Si le nom est calculé ailleurs à partir d'un
`new Date()`, le bug est silencieux et l'incohérence est publiée.

## Checklist de validation

**Chronologie**

- [ ] Tout timestamp du lot est dans `10:23` – `21:46`, sans exception, quel que soit N.
- [ ] 3 images → une seule rafale, écarts de 3–4 min, aucun saut d'heures.
- [ ] 6 images → 2 rafales, écart inter-rafale entre 4 h et 6 h.
- [ ] 9 images → 1 seule date civile, 3 rafales.
- [ ] 12 images → 2 dates civiles, 2 rafales par jour.
- [ ] 30 images → 3 dates civiles, écarts resserrés, jamais < 30 min.
- [ ] Aucune rafale ne démarre après `21:39` (elle ne finirait pas avant `21:46`).
- [ ] Ordre chronologique strictement croissant = ordre d'import.
- [ ] Dernière image antérieure à aujourd'hui — au plus tard hier soir.
- [ ] Les minutes de départ varient d'un lot à l'autre (gigue 0–40 min appliquée).

**Nommage**

- [ ] Nom de fichier et `DateTimeOriginal` décodent vers la même date/heure, à la seconde près.
- [ ] `IMG_####` toujours sur 4 chiffres avec zéros de tête ; `IMG_0000` jamais produit.
- [ ] Compteur de départ dans `[0800, 6500]`, constant sur le lot.
- [ ] Contigu dans une rafale (`+1`), saut de 2–7 entre rafales, saut de 4–26 au changement de jour.
- [ ] Compteur strictement croissant hors bouclage `9999 → 0001`.
- [ ] Deux lots successifs ne repartent pas du même compteur.
- [ ] Mode `strip` : nom neutre, jamais le nom d'origine.

## Points ouverts

- **`OffsetTimeOriginal`** n'est écrit nulle part aujourd'hui ; les dates sont donc en heure locale implicite.
  Cohérent tant que le nom de fichier est formaté avec les mêmes accesseurs locaux (`getHours()`), ce que fait
  la spec.
- **Weekends et jours fériés.** L'ancrage peut tomber n'importe quel jour de la semaine. Aucune contrainte
  posée : non pertinent tant que rien dans l'EXIF ne suggère un contexte professionnel.
