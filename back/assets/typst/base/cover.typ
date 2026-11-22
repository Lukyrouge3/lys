#set page(
  paper: "a4",
  margin: (x: 2cm, y: 2cm),
)

#set text(
  font: "New Computer Modern Sans",
  size: 10pt,
  lang: "en",
)

#set par(justify: true, leading: 0.65em)

// === EDIT THESE ===
#let sender = (
  name: "Torrenté Florian",
  email: "florian@deneria.net",
  phone: "+41 76 693 75 58",
  location: "Genève, Switzerland",
  link: "https://github.com/Lukyrouge3",
)

#let recipient = (
  name: "Lisa SCHNEIDER",
  company: "Liebherr",
  address: "Bulle, Switzerland",
)

#let subject = "Application — Software Engineering"
#let date = "May 2026"
// ==================

// Header — sender block
#align(right)[
  #text(size: 1.4em, weight: "bold", fill: rgb("#ff4136"))[#sender.name] \
  #text(size: 0.9em)[
    #sender.email \
    #sender.phone \
    #sender.location \
    #link("https://" + sender.link)[#sender.link]
  ]
]

#v(1em)

// Recipient block
#text[
  #recipient.name \
  #recipient.company \
  #recipient.address
]

#v(1em)

#align(right)[#date]

#v(1em)

#text(weight: "bold")[Subject: #subject]

#v(1.5em)

// === BODY ===
Hi,

#parbreak()

I'm applying for the Young Talent position in your Software Engineering team. What caught my attention immediately is Liebherr's industrial context — because that's exactly where I've been working for the past year.

#parbreak()

At IMA Automation, I'm part of the HMI team. I've built full-stack dashboards for real-time monitoring of industrial production lines, developed a WearOS application from scratch, and modernized Docker infrastructure. Working close to the hardware, where software has a direct and visible impact on physical systems, is something I genuinely enjoy.

#parbreak()

On the technical side, I work daily with React and have solid experience in C++ and object-oriented programming, which makes the transition to C\# straightforward. I'm comfortable picking up new frameworks, I've already worked with many different web frameworks and the adaption time gets smaller every time. I'm also familiar with scripting, CI/CD pipelines, and Docker from my current role.

#parbreak()

What appeals to me about this role specifically is the learning-oriented environment and the breadth of responsibilities, from frontend to backend to DevOps. That's the kind of position where you grow fast, and growing fast is what I'm optimizing for right now.
I'd be happy to discuss my experience further.

#parbreak()

Happy to talk whenever suits you.

#v(1em)

Best regards, \
#sender.name
