# Préfixes par appareil dans `processImage` (Metapurge)

## 1. Objectif

Chaque image qui sort de `processImage` doit porter **le nom de fichier réel de l'appareil qu'elle prétend être**.
Une image « Samsung Galaxy » ne doit jamais s'appeler `IMG_0001.jpg`, et une image « iPhone » ne doit jamais
s'appeler `20260725_143012.jpg`. Le préfixe fait partie de l'empreinte de l'appareil, exactement comme les
tags EXIF `Make` / `Model`.

Deuxième exigence, liée : `processImage` applique déjà un **décalage de temps** (time delta / offset) dans les
métadonnées. Ce même temps décalé doit servir à construire le nom de fichier. Nom de fichier et
`DateTimeOriginal` doivent toujours raconter la même histoire.

## 2. Règle centrale

> **Une seule source de vérité temporelle.**
> Le timestamp effectif écrit dans les métadonnées (après application du delta) est **le même objet** qui est
> passé au générateur de préfixe. Aucun appel à l'horloge système au moment de nommer le fichier.

```
timestampSource  ──►  applyTimeDelta()  ──►  effectiveTimestamp
                                                │
                                    ┌───────────┴────────────┐
                                    ▼                        ▼
                          writeMetadata(EXIF)        buildFileName(device, ts)
                          DateTimeOriginal           PXL_20260725_143012123.jpg
```

Si le delta déplace la photo au 24 juillet 23h50, le nom de fichier d'un Pixel doit être
`PXL_20260724_235012...`, pas `PXL_20260725_...`.

## 3. Catalogue des préfixes

| Marque / appareil | Motif de nom | Exemple | Type |
|---|---|---|---|
| iPhone (iOS) | `IMG_%04d` | `IMG_4821.HEIC` | compteur |
| iPhone (photo éditée) | `IMG_E%04d` | `IMG_E4821.JPG` | compteur (même index que l'originale) |
| Samsung Galaxy | `%Y%m%d_%H%M%S` | `20260725_143012.jpg` | horodaté |
| Samsung (rafale / doublon) | `%Y%m%d_%H%M%S(n)` | `20260725_143012(1).jpg` | horodaté |
| Google Pixel | `PXL_%Y%m%d_%H%M%S%3f` | `PXL_20260725_143012123.jpg` | horodaté + millisecondes |
| Xiaomi / Redmi / POCO | `IMG_%Y%m%d_%H%M%S` | `IMG_20260725_143012.jpg` | horodaté |
| Huawei / Honor | `IMG_%Y%m%d_%H%M%S` | `IMG_20260725_143012.jpg` | horodaté |
| OnePlus | `IMG_%Y%m%d_%H%M%S` | `IMG_20260725_143012.jpg` | horodaté |
| Oppo / Vivo / Realme | `IMG_%Y%m%d_%H%M%S` | `IMG_20260725_143012.jpg` | horodaté |
| Motorola | `IMG_%Y%m%d_%H%M%S%3f` | `IMG_20260725_143012456.jpg` | horodaté + ms |
| Sony (Xperia / Alpha) | `DSC_%05d` | `DSC_04821.JPG` | compteur |
| Nokia | `IMG_%Y%m%d_%H%M%S` | `IMG_20260725_143012.jpg` | horodaté |
| Capture d'écran Samsung | `Screenshot_%Y%m%d-%H%M%S_App` | `Screenshot_20260725-143012_Chrome.jpg` | horodaté |
| Capture d'écran iOS | `IMG_%04d` | `IMG_4822.PNG` | compteur |
| Fallback / appareil inconnu | `IMG_%Y%m%d_%H%M%S` | `IMG_20260725_143012.jpg` | horodaté |

Extensions par défaut : iPhone → `.HEIC` (ou `.JPG` si le pipeline sort du JPEG), tout le reste → `.jpg`.
La casse compte : iOS écrit en **majuscules** (`IMG_4821.HEIC`), Android en **minuscules** (`.jpg`).

## 4. Deux familles, deux comportements face au delta

### 4.1 Appareils horodatés (Samsung, Pixel, Xiaomi, Huawei, OnePlus…)

Le delta est **visible directement dans le nom**. Le formatage se fait en **heure locale de l'appareil**,
c'est-à-dire avec le même offset que celui écrit dans `OffsetTimeOriginal` — jamais en UTC, sinon le nom
et l'EXIF divergent d'autant d'heures que le fuseau.

### 4.2 Appareils à compteur (iPhone, Sony)

Le nom ne contient pas de date, donc le delta n'y apparaît pas. La contrainte devient l'**ordre** :

- Les images d'un même lot sont triées par `effectiveTimestamp` croissant, **après** application du delta.
- Le compteur est attribué dans cet ordre, de façon monotone.
- Conséquence : si le delta réordonne deux photos, leurs numéros `IMG_xxxx` doivent être réordonnés aussi.
  Un `IMG_4830` daté plus tôt qu'un `IMG_4829` est une incohérence détectable au premier coup d'œil.
- Le compteur boucle à `9999` → repart à `0001` (comportement réel d'iOS).
- Une variante éditée réutilise l'index de son originale avec le préfixe `IMG_E`.

## 5. Contrat d'API à intégrer

```js
// device : identifiant du profil d'appareil déjà sélectionné dans processImage
// timestamp : effectiveTimestamp, APRÈS applyTimeDelta
// index : compteur du lot (uniquement pour les appareils à compteur)
// variant : 'photo' | 'screenshot' | 'edited'
buildFileName({ device, timestamp, index, variant, ext }) -> string

getDevicePrefixSpec(device) -> {
  kind: 'timestamped' | 'counter',
  pattern: string,
  extension: string,
  case: 'upper' | 'lower',
}
```

Le catalogue de la section 3 vit dans **une table de données unique**, pas dans des `if/else` dispersés :
ajouter un appareil = ajouter une ligne, sans toucher à `processImage`.

## 6. Point d'insertion dans `processImage`

Ordre obligatoire à respecter :

1. Résolution du profil d'appareil (`Make` / `Model`).
2. Calcul de `effectiveTimestamp` = source + delta *(fonctionnalité déjà présente)*.
3. Écriture des métadonnées avec `effectiveTimestamp`.
4. **`buildFileName(...)` avec exactement ce même `effectiveTimestamp`** ← nouveau
5. Résolution des collisions.
6. Écriture / renommage du fichier de sortie.

L'étape 4 doit être **après** 2, et consommer sa sortie. Si le nom est calculé avant le delta, le bug est
silencieux : les fichiers sortent avec l'heure d'origine et trahissent le traitement.

## 7. Collisions

Deux images sur la même seconde produisent le même nom sur les appareils horodatés sans millisecondes.
Stratégie, par ordre de préférence :

1. Suffixe entre parenthèses, façon Samsung : `20260725_143012(1).jpg`.
2. Pour les appareils avec millisecondes (Pixel, Motorola), incrémenter les millisecondes plutôt que suffixer.
3. Jamais de suffixe aléatoire type `_a7f3` : aucun téléphone ne nomme comme ça.

Le registre des noms déjà émis est tenu **au niveau du lot**, pas par image.

## 8. Checklist de validation

- [ ] Un lot « iPhone » ne produit que des `IMG_%04d` avec extension en majuscules.
- [ ] Un lot « Samsung » ne produit que des `%Y%m%d_%H%M%S`.
- [ ] Delta de `+3 jours` → la date dans le nom des appareils horodatés bouge de 3 jours.
- [ ] Delta négatif franchissant minuit → le jour dans le nom recule (pas seulement l'heure).
- [ ] Nom de fichier et `DateTimeOriginal` décodent vers la même date/heure locale, à la seconde près.
- [ ] Fuseau non-UTC : le nom suit `OffsetTimeOriginal`, pas UTC.
- [ ] Appareils à compteur : ordre des index = ordre des timestamps décalés.
- [ ] Deux images à la même seconde → deux noms distincts, tous deux plausibles pour l'appareil.
- [ ] Appareil inconnu → fallback `IMG_%Y%m%d_%H%M%S`, jamais de nom vide ni de nom d'origine conservé.

## 9. Ce qui reste à faire côté code

Ce document est la spec. L'intégration dans `processImage` n'a **pas** pu être écrite : le dépôt courant
(`scss-lightning-css-react-template`) est le template React de base — `src/` ne contient que `App.jsx`,
`main.jsx`, les feuilles de style et `react.svg`. Il n'y a aucun fichier Metapurge ni aucun `processImage`
dans cet arbre. Pour brancher le code, il faut m'ouvrir le dépôt Metapurge ; je n'aurai alors besoin de lire
que le fichier de `processImage` et son point d'écriture de sortie.
