type IconName =
  | 'add'
  | 'close'
  | 'lock'
  | 'unlock'
  | 'arrow'
  | 'download'
  | 'print'
  | 'check'
  | 'copy'
  | 'remove';

const paths: Record<IconName, string> = {
  add: 'M12 5v14M5 12h14',
  close: 'm6 6 12 12M18 6 6 18',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3',
  unlock: 'M7 10V7a5 5 0 0 1 9.5-2M5 10h14v11H5zM12 14v3',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  print: 'M7 8V3h10v5M7 17H4V8h16v9h-3M7 14h10v7H7zM17 11h.01',
  check: 'm5 12 4 4L19 6',
  copy: 'M9 8h11v13H9zM15 8V3H4v13h5',
  remove: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
};

export default function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
