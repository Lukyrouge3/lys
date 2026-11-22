#import "@preview/moderner-cv:0.2.1": *

#let skill(title, rating, desc: none) = stack(dir: ttb, spacing: .6em,
  text(size: .8em, strong(title)),
  stack(dir: ltr, spacing: 4pt,
  ..for i in range(5) {
    (circle(stroke: 1.5pt+red, height: .3em, fill: if rating > i {red}),)
  }),
  text(size: .8em, desc)
)

#show link: underline

#show: moderner-cv.with(
  name: "Torrenté Florian",
  lang: "fr",
  subtitle: "Développeur Logiciel Junior",
  social: (
    // predefined socials: phone, email, github, linkedin, x, bluesky
    email: "florian@deneria.net",
    github: "Lukyrouge3",
    linkedin: "florian-torrente",
    // custom socials: (icon, link, body)
    // any fontawesome icon can be used: https://fontawesome.com/search
    phone: "+41 76 693 75 58",
    address: "39av Edmond-Vaucher, 1219 Châtelaine"
  ),
  color: rgb("#000"),
  show-footer: false,
)

= Expériences

#cv-entry-multiline(
  date: [Mars 2026 -- Présent],
  title: [Trainee Software Industrial Systems],
  employer: [IMA Automation],
  [#text(10pt, [
      #linebreak()
      • Développé des tableaux de bord full-stack (Svelte/React, 
  backend, BDD) pour le monitoring temps réel d'outils 
  industriels, utilisés par \~30 personnes en interne
  #linebreak()
      • Piloté en autonomie le développement d'une application 
        WearOS de monitoring industriel, de zéro (backend dédié + app)
        #linebreak()
      • Réimplémenté un driver de communication pour les PLC Rockwell (protocol CIP)
      #linebreak()
      Technologies utilisées: *C++*, *React*, *Svelte*, *Python*, *Bash*, *Kotlin*
    ]
  )],
)
#linebreak()
#cv-entry-multiline(
  date: [2024 -- 2025],
  title: [Développeur web fullstack],
  employer: [Junior 42 Lausanne],
  [#text(10pt, [
    Réalisation de 3 mandats clients en autonomie, de la conception 
    à la mise en production.
    #linebreak()
    • #link("https://openurbanism.ch/fr")[#fa-link(rgb("#ff4136")) Open Urbanism Foundation] — 
    Réécriture complète d'une application existante et création d'un back-office
    #linebreak()
    • #link("https://www.wechip.ch/")[#fa-link(rgb("#ff4136")) WeChip] — 
    Proof-of-concept et back-office en collaboration inter-entreprises
    #linebreak()
    Technologies utilisées: *Svelte*, *React*, *Supabase*, *TypeScript*, *OAuth*, *Shopify*
  ])],
)
#linebreak()
= Hackathons

#cv-entry-multiline(
  date: [Sept. 2025],
  title: [Recherche et développement],
  employer: [Société industrielle suisse],
  [1er place],
  [
  Technologies utilisées: *Kotlin*, *Typescript*
]
)
#cv-entry-multiline(
  date: [Août 2025],
  title: [Amélioration boîte mail avec IA],
  employer: [Infomaniak],
  [2ème place],
  [
  Technologies utilisées: *TypeScript*, *Extension chrome*, *LLM*
]
)
// #cv-entry-multiline(
//   date: [Mars 2025],
//   title: [Privacy and Verifiability],
//   employer: [DoraHacks],
//   [3ème place de la track Mina],
//   [
//     Création d'un jeu sur le principe du *Zero Knowledge Proof*. #link("https://dorahacks.io/buidl/23841")[#fa-link(rgb("#ff4136")) Notre solution]
//     #linebreak()
//   Technologies utilisées: *TypeScript*, *Blockchain*, *zkProof*, *Mina*
// ]
// )
#linebreak()
= Formations
#cv-entry-multiline(
  date: [2026 -- Présent],
  employer: [42 Lausanne],
  title: [Expert en architecture informatique],
  [Master professionnel, en parallèle de l'activité professionnelle],
  link("https://www.francecompetences.fr/recherche/rncp/39774/")[#fa-link(rgb("#ff4136")) RNCP 39774],
)
#cv-entry-multiline(
  date: [2023 -- 2026],
  employer: [École 42 Lausanne],
  title: [Software Engineer],
  link("https://42lausanne.ch/")[#fa-link(rgb("#ff4136")) https://42lausanne.ch/],
)
#cv-entry-multiline(
  date: [2017 -- 2022],
  employer: [CEC André-Chavanne],
  title: [Maturité Gymnasiale],
  [#text(10pt, [Spécialité physique et application des maths])],
)
#linebreak()

= Compétences
#cv-line[
  Langues
][
  Français (langue maternelle), Anglais (courant)
]
#cv-line[
  Programmation
][
  PHP, Laravel, TypeScript, Svelte, React, NextJS, C/C++, SQL, Docker, Git/CI-CD
]
= Projets personnels
#cv-line[][*Création d'un Kernel*, BootLoader, GDT, Paging (C, Assembleur)#linebreak()#link("https://github.com/Lukyrouge3/kernel")[#fa-link(rgb("#ff4136")) https://github.com/Lukyrouge3/kernel]]
#cv-line[][*Reverse engineer Grand Fantasia*, Émulateur de serveur de jeu (Ghidra, DLL Injection, Proxy, MITM)]
// #cv-line[][*Domain and SSL Monitor*, Supervision de domaines et certificats SSL, renouvellement automatique (PHP, Laravel, Redis, Svelte) #linebreak()#link("https://ssl.deneria.net/")[#fa-link(rgb("#ff4136")) https://ssl.deneria.net/]]

//   #block(above: .5em, below: .5em, grid(columns: (1fr, 1.2fr, 1.2fr, 1.2fr, 1.2fr), gutter: 2em, 
//   [],
//   skill([Programmation C/C++], 5),
//   skill([Web], 5, desc: [TypeScript, SQL, HTML, CSS]),
//   skill([Frameworks web], 5, desc: [Svelte, React, NextJS]),
//   skill([Git], 5, desc: [GitHub, CI/CD, Conventional commits]),
//   [],
//   skill([Docker], 4),
//   skill([Français], 5, desc: [Langue maternelle]),
//   skill([Anglais], 4, desc: [Courant])
// ))