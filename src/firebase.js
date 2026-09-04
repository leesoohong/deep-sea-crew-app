import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyDb0EwwxZ4w-Hne82JoH-fy2JigPxzyzsM',
  authDomain: 'deep-sea-crew.firebaseapp.com',
  databaseURL: 'https://deep-sea-crew-default-rtdb.firebaseio.com',
  projectId: 'deep-sea-crew',
  storageBucket: 'deep-sea-crew.firebasestorage.app',
  messagingSenderId: '617686540511',
  appId: '1:617686540511:web:260c10c50275b00eddc96a',
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);
