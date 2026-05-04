import styles from './Container.module.scss';
import { ReactNode } from 'react';

interface ContainerProps {

  children: ReactNode;
  className?: string;

}

export default function Container({ children, className = '' }: ContainerProps) {

  return (

    <div className = { `${styles.container} ${className}` }>

      { children }

    </div>

  );

}
