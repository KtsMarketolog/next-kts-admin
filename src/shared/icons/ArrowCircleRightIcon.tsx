import { FC, SVGProps } from 'react';

interface ArrowCircleRightIconProps extends SVGProps<SVGSVGElement> {
  
  circleFill?: string;

}

export const ArrowCircleRightIcon: FC<ArrowCircleRightIconProps> = ({

  circleFill = '#8D81C4',
  ...props

}) => (

  <svg

    width="59"
    height="58"
    viewBox="0 0 59 58"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}

  >
    <ellipse cx="29.6115" cy="28.998" rx="28.8889" ry="28.5" fill={circleFill} />

    <g clipPath="url(#clip0_220_185)">
      <path
        d="M41.554 28.3314C41.5538 28.3311 41.5535 28.3307 41.5532 28.3305L36.5638 23.432C36.1901 23.0651 35.5855 23.0664 35.2134 23.4352C34.8414 23.804 34.8428 24.4004 35.2166 24.7674L38.5665 28.0561H18.3445C17.8171 28.0561 17.3896 28.4779 17.3896 28.9982C17.3896 29.5184 17.8171 29.9402 18.3445 29.9402H38.5664L35.2167 33.2289C34.8429 33.5959 34.8415 34.1923 35.2135 34.5611C35.5855 34.9299 36.1902 34.9312 36.5639 34.5643L41.5532 29.6659C41.5535 29.6656 41.5538 29.6652 41.5541 29.665C41.9281 29.2967 41.9269 28.6984 41.554 28.3314Z"
        fill="white"
      />
    </g>

    <defs>
      <clipPath id="clip0_220_185">
        <rect
          width="24.4445"
          height="24.1154"
          fill="white"
          transform="translate(17.3896 16.9404)"
        />
      </clipPath>
    </defs>

  </svg>

);
