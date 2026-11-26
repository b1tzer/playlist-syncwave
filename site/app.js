const header = document.getElementById('siteHeader');
const navToggle = document.getElementById('navToggle');
const nav = document.getElementById('siteNav');

function closeNav() {
  header.classList.remove('nav-open');
  navToggle.setAttribute('aria-expanded', 'false');
  navToggle.setAttribute('aria-label', '打开导航菜单');
  navToggle.querySelector('use').setAttribute('href', '#i-menu');
}

window.addEventListener(
  'scroll',
  () => {
    header.classList.toggle('is-scrolled', window.scrollY > 12);
  },
  { passive: true }
);

navToggle.addEventListener('click', () => {
  const open = !header.classList.contains('nav-open');
  header.classList.toggle('nav-open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  navToggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
  navToggle.querySelector('use').setAttribute('href', open ? '#i-close' : '#i-menu');
});

nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeNav));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeNav();
});

const revealItems = document.querySelectorAll('.reveal');

if ('IntersectionObserver' in window) {
  document.documentElement.classList.add('js-reveal');

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
  );

  revealItems.forEach((item) => observer.observe(item));
} else {
  revealItems.forEach((item) => item.classList.add('is-visible'));
}
