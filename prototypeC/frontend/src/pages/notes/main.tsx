import 'solid-js/web';
import { render } from 'solid-js/web';
import { NotesApp } from './NotesApp';
import '../../styles/main.css';

render(() => <NotesApp />, document.getElementById('notes-app')!);
