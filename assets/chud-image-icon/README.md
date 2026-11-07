# Icône Chud Image

Liseuse de photos. Dessin vectoriel simple, sans image intégrée ni police. Fond transparent sauf `icon-square`.

| Fichier | Usage |
|---|---|
| `svg/logo-small.svg` | Fichier maître, 32 px et plus |
| `svg/logo-tiny.svg` | Version épurée pour 16 à 24 px |
| `svg/icon-macos.svg` | Tuile macOS |
| `svg/icon-square.svg` | Carré plein pour iOS et les boutiques |
| `icon.ico` / `icon.icns` | Windows / macOS |
| `favicon.svg` | Favicon web |
| `png/` | PNG de 16 à 1024 px |

Couleurs : marine `#011128`, bleu `#123f7d`, or `#f9c83a`, cyan `#38d6ff`, blanc `#ffffff`.

Consigne pour Claude Code : « Le dossier `chud-image-icon/` contient l'icône de l'application. Lis son `README.md` et branche-la partout (exécutable, fenêtre, barre des tâches, favicon). Ne modifie pas les fichiers. »

## Fond cyan `#38d6ff`

Le fond cyan est utilisé sur toutes les icônes qui exigent un fond. Les PNG de `png/`, `icon.ico` et `favicon.svg` restent transparents.

| Dossier | Usage |
|---|---|
| `android/` | À copier dans `app/src/main/res/` : icône adaptative (API 26+), PNG classiques et ronds pour toutes les densités, couleur de fond |
| `tv/` | Bannières Android TV 320x180, 1280x720 et 1920x1080 |
| `store/` | PNG sans transparence : App Store / iOS (1024), Play Store (512), `apple-touch-icon` (180), PWA maskable (512), tuile macOS |
| `svg/android-foreground.svg`, `svg/tv-banner.svg` | Sources vectorielles de ces formats |

Android TV recommande d'inclure le nom de l'application dans la bannière : ajoutez-le à `svg/tv-banner.svg` avant publication.

Manifeste Android : `android:icon="@mipmap/ic_launcher"`, `android:roundIcon="@mipmap/ic_launcher_round"` et, pour la TV, `android:banner="@drawable/banner"` avec `tv/banner-320x180.png` copié dans `res/drawable-xhdpi/banner.png`.
