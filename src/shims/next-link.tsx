import React from 'react';
import { Link as RRLink } from 'react-router-dom';

export interface LinkProps {
  href?: string;
  to?: string;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  title?: string;
  'aria-label'?: string;
  target?: string;
  rel?: string;
  [key: string]: any;
}

export default function Link({ href, to, children, className, style, onClick, title, 'aria-label': ariaLabel, target, rel, ...rest }: LinkProps) {
  const destination = href || to || '#';
  return (
    <RRLink
      to={destination}
      className={className}
      style={style}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      target={target}
      rel={rel}
      {...rest}
    >
      {children}
    </RRLink>
  );
}
