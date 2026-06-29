// Central place for site-wide identity and metadata.

export const SITE_TITLE = 'Michael Assaf';
export const SITE_DESCRIPTION =
  'Writing and notes by Michael Assaf (snowmead) — software, systems, and the occasional rabbit hole.';

export const AUTHOR = {
  name: 'Michael Assaf',
  handle: 'snowmead',
};

export const NAV_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/blog', label: 'Blog' },
] as const;

export const SOCIALS = [
  { name: 'GitHub', href: 'https://github.com/snowmead' },
  { name: 'X', href: 'https://x.com/snowmead' },
  { name: 'LinkedIn', href: 'https://www.linkedin.com/in/michael-assaf/' },
] as const;
