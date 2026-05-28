import { managerIdValue, type Manager } from './AdminClientsModel';

type AdminClientManagerSelectProps = {
  value: number | null;
  onChange: (value: number | null) => void;
  options: Manager[];
  placeholder: string;
};

export function AdminClientManagerSelect({ value, onChange, options, placeholder }: AdminClientManagerSelectProps) {
  return (
    <select value={managerIdValue(value)} onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}>
      <option value="">{placeholder}</option>
      {options.map((manager) => (
        <option key={manager.id} value={manager.id}>
          {manager.name}
        </option>
      ))}
    </select>
  );
}
