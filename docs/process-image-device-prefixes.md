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

## A.2 Fenêtre selon le volume

| Nombre d'images | Fenêtre | Clusters | Écart inter-cluster |
|---|---|---|---|
| 1 – 9 | **14 h** | 1 – 3 | 4 – 6 h (naturel) |
| 10 – 18 | **24 h** | 4 – 6 | 4 – 6 h, resserré si nécessaire |
| 19 et + | **48 h** | 7 et + | resserré pour tenir dans 48 h |

Règle de resserrement : l'écart nominal est tiré dans `[4h, 6h]`. Si `(nClusters - 1) × 6h` dépasse la
fenêtre, l'écart est recalculé en `fenêtre / (nClusters - 1)` avec une gigue de ±20 %, plancher à **30 min**
pour que deux clusters ne se chevauchent jamais.

Vérification aux bornes :

| N | Clusters | Écarts | Nominal max | Fenêtre | Résultat |
|---|---|---|---|---|---|
| 9 | 3 | 2 | 12 h | 14 h | tient, 4–6 h conservés |
| 12 | 4 | 3 | 18 h | 24 h | tient, 4–6 h conservés |
| 18 | 6 | 5 | 30 h | 24 h | resserré à ~4 h 48 |
| 19 | 7 | 6 | 36 h | 48 h | tient, 4–6 h conservés |
| 60 | 20 | 19 | 114 h | 48 h | resserré à ~2 h 31 |

Le modèle se dégrade proprement : plus il y a d'images, plus les rafales se rapprochent, jamais l'inverse.

## A.3 Ancrage

La chronologie est construite **à rebours** depuis une ancre : la dernière image du lot est datée
`maintenant − aléatoire(1 h … 48 h)`, puis on remonte le temps cluster par cluster. Le lot est donc
« récent mais pas à la seconde du traitement », et l'ordre d'import est préservé en ordre chronologique
croissant.

## A.4 Le point structurel : un planificateur de lot

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

## A.5 Pseudo-code

```js
const MIN = 60_000, HOUR = 60 * MIN;

function buildBatchTimeline(count) {
  const window = count <= 9 ? 14 * HOUR : count <= 18 ? 24 * HOUR : 48 * HOUR;
  const nClusters = Math.ceil(count / 3);
  const nGaps = Math.max(1, nClusters - 1);

  // écart nominal 4-6 h, resserré si le lot ne tient pas dans la fenêtre
  const compress = nGaps * 6 * HOUR > window;
  const gapFor = () => compress
    ? Math.max(30 * MIN, (window / nGaps) * (0.8 + Math.random() * 0.4))
    : 4 * HOUR + Math.random() * 2 * HOUR;

  // durée de chaque rafale, puis somme totale
  const clusters = [];
  for (let c = 0; c < nClusters; c++) {
    const size = Math.min(3, count - c * 3);
    const gaps = Array.from({ length: size - 1 }, () => 3 * MIN + Math.random() * MIN);
    clusters.push({ size, gaps });
  }
  const interGaps = Array.from({ length: nClusters - 1 }, gapFor);

  const span = clusters.reduce((s, c) => s + c.gaps.reduce((a, b) => a + b, 0), 0)
             + interGaps.reduce((a, b) => a + b, 0);

  // ancrage : la dernière image tombe entre 1 h et 48 h avant maintenant
  let t = Date.now() - (HOUR + Math.random() * 47 * HOUR) - span;

  const out = [];
  clusters.forEach((c, ci) => {
    for (let i = 0; i < c.size; i++) {
      out.push(new Date(t));
      if (i < c.size - 1) t += c.gaps[i];
    }
    if (ci < interGaps.length) t += interGaps[ci];
  });
  return out;
}
```

## A.6 Écriture EXIF

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
La chronologie étant construite croissante par ordre d'import, l'index suit simplement `i` : `IMG_4821`,
`IMG_4822`, `IMG_4823`. Le compteur démarre à une valeur aléatoire plausible (1000–8000) tirée **une fois par
lot**, et boucle à 9999 → 0001.

## B.4 Collisions

Deux images à la même seconde sont impossibles avec des écarts intra-cluster de 3 minutes, mais le garde-fou
reste utile si la fenêtre est un jour resserrée davantage : suffixe entre parenthèses façon Samsung
(`20260724_143012(1).jpg`), ou incrément des millisecondes pour le Pixel. Jamais de suffixe aléatoire
type `_a7f3` : aucun téléphone ne nomme comme ça. Le registre des noms émis est tenu au niveau du lot.

## B.5 Le nom doit sortir de la fonction

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
2. Tirage du compteur de départ, une fois pour le lot (appareils à compteur).
3. Par image `i` : `processImageFile(files[i], { ...opts, timestamp: timeline[i] })`.
4. Dans la fonction : `shot = options.timestamp` → EXIF **et** `buildFileName`.
5. Résolution des collisions au niveau du lot.
6. Téléchargement sous le nom généré.

L'étape 4 doit consommer la même valeur pour les deux sorties. Si le nom est calculé ailleurs à partir d'un
`new Date()`, le bug est silencieux et l'incohérence est publiée.

## Checklist de validation

- [ ] 3 images → un seul cluster, écarts de 3–4 min, aucun saut d'heures.
- [ ] 6 images → 2 clusters, écart inter-cluster entre 4 h et 6 h.
- [ ] 9 images → étalement total ≤ 14 h.
- [ ] 12 images → étalement total ≤ 24 h.
- [ ] 30 images → étalement total ≤ 48 h, écarts resserrés, jamais < 30 min.
- [ ] Ordre chronologique strictement croissant = ordre d'import, quel que soit N.
- [ ] Dernière image du lot antérieure à `maintenant`, d'au moins 1 h.
- [ ] Nom de fichier et `DateTimeOriginal` décodent vers la même date/heure, à la seconde près.
- [ ] Appareils à compteur : index croissants, compteur de départ constant sur le lot.
- [ ] Mode `strip` : nom neutre, jamais le nom d'origine.

## Points ouverts

- **Heures nocturnes.** L'ancrage aléatoire peut placer une rafale à 4 h du matin. Contraindre les clusters à
  une plage 8 h – 23 h rendrait le lot plus plausible, au prix d'un étalement moins régulier. Non tranché.
- **`OffsetTimeOriginal`** n'est écrit nulle part aujourd'hui ; les dates sont donc en heure locale implicite.
  Cohérent tant que le nom de fichier est formaté avec les mêmes accesseurs locaux (`getHours()`), ce que fait
  la spec.
