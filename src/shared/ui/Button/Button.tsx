import React, { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.scss';

type ButtonVariant = 'primary' | 'secondary' | 'purple';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {

  variant?: ButtonVariant;
  children: ReactNode;
  withBg?: boolean; 

}

const Button: React.FC<ButtonProps> = ({ variant = 'primary', withBg = false, children, ...props }) => {

  return (

    <button

      className = { `${styles.button} ` + `${styles[variant]} ` + `${withBg ? styles.withBg : ''}` }
      
      {...props}

    >

      { children }

    </button>

  );

};

export default Button;
