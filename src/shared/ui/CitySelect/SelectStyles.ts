import { StylesConfig } from 'react-select';

type OptionType = {

  value: string;
  label: string;

};
export const customSelectStyles: StylesConfig<OptionType, false> = {

  container: (base) => ({
    ...base,
    width: '100%',

  }),

  control: (base, state) => ({

    ...base,
    backgroundColor: '#303639',
    borderRadius: '16px',
    border: '1px solid rgba(160, 130, 220, 0.3)',
    padding: '4px 2px',
    fontSize: '16px',
    color: '#B1B1B1',
    fontFamily: 'inherit',
    boxShadow: state.isFocused ? '0 0 0 3px rgba(160, 130, 220, 0.25)' : 'none',
    borderColor: state.isFocused ? '#a082dc' : 'rgba(160, 130, 220, 0.3)',
    '&:hover': {
      borderColor: 'rgba(160, 130, 220, 0.5)',
    },

  }),
  placeholder: (base) => ({

    ...base,
    color: '#999',

  }),
  input: (base) => ({

    ...base,
    color: '#B1B1B1',
  }),

  singleValue: (base) => ({

    ...base,
    color: '#B1B1B1',

  }),

  menu: (base) => ({

    ...base,
    backgroundColor: '#303639',
    color: '#B1B1B1',
    borderRadius: '12px',
    marginTop: 2,

  }),

  option: (base, state) => ({

    ...base,
    backgroundColor: state.isFocused ? '#3f4650' : 'transparent',
    color: '#B1B1B1',
    cursor: 'pointer',

  }),

};