# Energy Literacy Education Portal

Page: `/learn` (`src/app/learn/page.tsx`). Content served by backend `backend/src/routes/education.ts`.

- **Modules:** Solar Basics, Energy Efficiency, The Grid — each with a lesson and quiz.
- **Simulation:** interactive solar output calculator (panel kW × sun hours × 80%).
- **Badges & certificate:** passing a quiz (≥70%) awards its badge; completing all modules issues a certificate.
- **Multi-language:** English, French, Spanish (selector top-right). Add a language by adding its key to each module's `title`, `lesson` and `quiz.q`.
- **Mobile-friendly:** responsive Tailwind layout with wrapping controls.
- **Progress tracking:** keyed by wallet address (or `guest`).

API: `GET /api/education/modules`, `POST /api/education/:userId/:moduleId/submit {answers}`, `GET /api/education/:userId/progress`.
