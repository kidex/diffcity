import type { ReactNode } from 'react';

interface BadgeProps {
  label: string;
  children?: ReactNode;
}

export const Badge = ({ label, children }: BadgeProps) => (
  <span className="badge">
    {label}
    {children}
  </span>
);

export function Panel({ title }: { title: string }) {
  const Header = () => <h2>{title}</h2>;
  return (
    <section>
      <Header />
    </section>
  );
}

export default Panel;
