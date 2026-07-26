import { render, screen } from '@testing-library/react';
import App from './App';

test('renders VideoMeet Pro heading', () => {
  render(<App />);
  expect(
    screen.getByRole('heading', { name: /videomeet pro/i })
  ).toBeInTheDocument();
});