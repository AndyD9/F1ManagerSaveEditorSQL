# F1 Manager Save Editor

Éditeur de saves **F1 Manager 22 / 23 / 24** qui tourne entièrement dans le navigateur : unpack du `.sav`, édition de la base SQLite, repack. Rien n'est envoyé sur un serveur.

**Version en ligne :** https://andyd9.github.io/F1ManagerSaveEditorSQL/

Il réunit dans un seul outil :
- le repacker de [xAranaktu/F1-Manager-2022-SaveFile-Repacker](https://github.com/xAranaktu/F1-Manager-2022-SaveFile-Repacker) (unpack / repack, mêmes fichiers `chunk1`, `main.db`, `backup1.db`, `backup2.db`) ;
- l'édition de [f1dbeditor.com](https://www.f1dbeditor.com/) ([IUrreta/DatabaseEditor](https://github.com/IUrreta/DatabaseEditor)).

## Utilisation

1. Ouvre la version en ligne, ou double-clique sur `index.html` (ou lance `Lancer.bat`, qui sert la page sur `http://localhost:8765`).
2. Glisse ta save : `%LOCALAPPDATA%\F1Manager24\Saved\SaveGames\*.sav`.
3. Modifie, puis **Enregistrer** (Ctrl+S). Au premier écrasement, une copie de la save d'origine est téléchargée par sécurité.

Ctrl+Z annule la dernière modification ; l'onglet **Journal** liste tout ce qui a été changé.

## Pages

| Onglet | Contenu |
|---|---|
| Développement | Coût des designs par pièce, vitesses de dev (coût, expertise par jour), prix calculé, expertise et designs par équipe |
| Performances | Classement des voitures (overall + attributs en unités du jeu), édition des stats de pièces de n'importe quelle équipe, boost, copie de voiture |
| Staff & pilotes | Fiche pilote / staff : stats, potentiel, âge, retraite, numéro, super licence, moral, contrat |
| Équipe & finances | Solde, budget cap dépensé, confiance du board, pit crew, primes, coûts staff |
| Installations | Niveau et état des bâtiments, coûts et effets par niveau |
| Règlement & calendrier | Budget cap, limites moteur, soufflerie / CFD, barèmes, météo des courses, circuits |
| Tables / SQL | Toutes les tables éditables (noms lisibles, interrupteurs, dates, montants) et console SQL |
| Unpack / Repack | Export / import de `main.db`, repack depuis les fichiers du repacker Python |

## Fichiers

- `savefile.js` : lecture / écriture du format `.sav` (en-tête GVAS + 3 bases SQLite compressées zlib).
- `app.js` : interface et éditeurs.
- `index.html`, `styles.css`.

Dépendances chargées depuis cdnjs : [sql.js](https://github.com/sql-js/sql.js) et [pako](https://github.com/nodeca/pako).

## Avertissement

Garde toujours une copie de ta save. L'overall des voitures reprend la formule de f1dbeditor : c'est une estimation, pas le calcul exact du jeu.
