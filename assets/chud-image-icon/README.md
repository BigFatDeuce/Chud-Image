# Icône Chud Image

Dessin vectoriel pur (formes SVG, aucune image intégrée, aucune police). Fond transparent sauf `icon-square` et `icon-maskable`.

## Quel fichier pour quoi

| Fichier | Usage |
|---|---|
| `svg/logo.svg` | Fichier maître, écran « À propos », splash, grandes tailles (128 px et plus) |
| `svg/logo-small.svg` | Version simplifiée pour 32 à 64 px |
| `svg/logo-tiny.svg` | Version très simplifiée pour 16 à 24 px |
| `svg/icon-macos.svg` | Tuile macOS avec marges officielles (824/1024) |
| `svg/icon-square.svg` | Carré plein bord à bord, pour iOS et les boutiques |
| `svg/icon-maskable.svg` | Android adaptatif et PWA maskable, dessin dans la zone sûre |
| `icon.ico` | Windows, 9 tailles de 16 à 256 px |
| `icon.icns` | macOS, de 16 à 1024 px |
| `favicon.svg` | Favicon web |
| `png/icon-N.png` | PNG transparents, chaque taille utilise la bonne version |

## Règle importante

Ne pas réduire `logo.svg` en dessous de 128 px : les détails deviennent illisibles. Utiliser les PNG fournis ou les versions `small` et `tiny`.

## Couleurs

| Rôle | Hex |
|---|---|
| Bleu ciel foncé | `#1f74d6` |
| Bleu ciel | `#7cc4f5` |
| Bleu lac | `#0f4f9e` |
| Vert colline | `#2f8a3c` |
| Contour cadre | `#8fb3d6` |
| Marine (lunettes) | `#011128` |
| Blanc cadre | `#ffffff` |

## Consigne à copier dans Claude Code

> Le dossier `chud-image-icon/` contient l'icône de l'application. Lis son `README.md` et branche-la partout : icône de fenêtre et d'exécutable (`icon.ico`, `icon.icns`, `png/`), barre des tâches, favicon, et écran « À propos » avec `svg/logo.svg`. Ne redessine rien et n'altère pas les fichiers. Reprends les couleurs du README pour le thème de l'interface.

## Fond cyan `#38d6ff`

Le fond cyan remplace l'ancien fond bleu sur toutes les icônes qui exigent un fond. Les PNG de `png/`, `icon.ico` et `favicon.svg` restent transparents.

| Dossier | Usage |
|---|---|
| `android/` | À copier dans `app/src/main/res/` : icône adaptative (API 26+), PNG classiques et ronds pour toutes les densités, couleur de fond |
| `tv/` | Bannières Android TV 320x180, 1280x720 et 1920x1080 |
| `store/` | PNG sans transparence : App Store / iOS (1024), Play Store (512), `apple-touch-icon` (180), PWA maskable (512), tuile macOS |
| `svg/android-foreground.svg`, `svg/tv-banner.svg` | Sources vectorielles de ces formats |

Android TV recommande d'inclure le nom de l'application dans la bannière : ajoutez-le à `svg/tv-banner.svg` avant publication.

Manifeste Android : `android:icon="@mipmap/ic_launcher"`, `android:roundIcon="@mipmap/ic_launcher_round"` et, pour la TV, `android:banner="@drawable/banner"` avec `tv/banner-320x180.png` copié dans `res/drawable-xhdpi/banner.png`.
