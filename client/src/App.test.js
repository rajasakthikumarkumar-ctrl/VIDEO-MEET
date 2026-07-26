import { render, screen } from '@testing-library/react';
import App from './App';

test('renders VideoMeet Pro', () => {
  render(<App />);
  const title = screen.getByText(/videomeet pro/i);
  expect(title).toBeInTheDocument();
});