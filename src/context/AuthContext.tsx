import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  User,
} from 'firebase/auth';
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { auth, db, googleProvider, handleFirestoreError, OperationType } from '../lib/firebase';
import { ADMIN_BOOTSTRAPPED_EMAIL, FREE_PLAN_SPECS, UserProfile } from '../types/hosting';

interface AuthContextValue {
  user: User | null;
  profile: UserProfile | null;
  isAdmin: boolean;
  loading: boolean;
  authError: string | null;
  clearAuthError: () => void;
  loginWithGoogle: () => Promise<boolean>;
  loginWithEmail: (email: string, password: string) => Promise<boolean>;
  registerWithEmail: (name: string, email: string, password: string) => Promise<boolean>;
  resendVerification: () => Promise<void>;
  refreshAuthUser: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function mapAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code || '';
  if (code === 'auth/operation-not-allowed') {
    return 'Email/Password sign-in is not enabled in Firebase Authentication yet. Enable it in Firebase Console → Authentication → Sign-in method, or use Continue with Google.';
  }
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return 'Invalid email or password. Please verify your credentials.';
  }
  if (code === 'auth/email-already-in-use') {
    return 'An account with this email already exists. Try signing in instead.';
  }
  if (code === 'auth/weak-password') {
    return 'Password should be at least 6 characters.';
  }
  if (code === 'auth/popup-closed-by-user') {
    return 'Sign-in popup was closed before completing authentication.';
  }
  return err instanceof Error ? err.message : 'Authentication failed.';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isAdminDoc, setIsAdminDoc] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let unsubProfile: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      if (unsubProfile) {
        unsubProfile();
        unsubProfile = null;
      }

      setUser(firebaseUser);

      if (!firebaseUser) {
        setProfile(null);
        setIsAdminDoc(false);
        setLoading(false);
        return;
      }

      const userRef = doc(db, 'users', firebaseUser.uid);

      // Ensure user profile exists and meets updated 10-server FREE plan quota
      if (firebaseUser.emailVerified) {
        try {
          const existingSnap = await getDoc(userRef);
          if (!existingSnap.exists()) {
            await setDoc(userRef, {
              uid: firebaseUser.uid,
              displayName: (firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'Developer').slice(0, 80),
              email: (firebaseUser.email || 'user@facon.host').slice(0, 160),
              photoURL: (firebaseUser.photoURL || '').slice(0, 512),
              role: 'user',
              plan: 'FREE',
              suspended: false,
              serverLimit: FREE_PLAN_SPECS.maxServersPerUser,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } else {
            const existingData = existingSnap.data() as Partial<UserProfile>;
            if (
              !existingData.suspended &&
              typeof existingData.serverLimit === 'number' &&
              existingData.serverLimit < FREE_PLAN_SPECS.maxServersPerUser
            ) {
              await updateDoc(userRef, {
                serverLimit: FREE_PLAN_SPECS.maxServersPerUser,
                updatedAt: serverTimestamp(),
              });
            }
          }
        } catch (err) {
          console.warn('Profile bootstrap warning:', err);
        }
      }

      // Check optional admin doc
      try {
        const adminSnap = await getDoc(doc(db, 'admins', firebaseUser.uid));
        setIsAdminDoc(adminSnap.exists());
      } catch {
        setIsAdminDoc(false);
      }

      unsubProfile = onSnapshot(
        userRef,
        (snap) => {
          if (snap.exists()) {
            setProfile(snap.data() as UserProfile);
          } else {
            setProfile(null);
          }
          setLoading(false);
        },
        (error) => {
          setLoading(false);
          try {
            handleFirestoreError(error, OperationType.GET, `users/${firebaseUser.uid}`);
          } catch (e) {
            console.error(e);
          }
        }
      );
    });

    return () => {
      unsubAuth();
      if (unsubProfile) unsubProfile();
    };
  }, []);

  const isAdmin =
    Boolean(user?.emailVerified) &&
    (user?.email === ADMIN_BOOTSTRAPPED_EMAIL || isAdminDoc || profile?.role === 'admin');

  const clearAuthError = () => setAuthError(null);

  const loginWithGoogle = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
      return true;
    } catch (err) {
      setAuthError(mapAuthError(err));
      return false;
    }
  };

  const loginWithEmail = async (email: string, password: string) => {
    setAuthError(null);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      return true;
    } catch (err) {
      setAuthError(mapAuthError(err));
      return false;
    }
  };

  const registerWithEmail = async (name: string, email: string, password: string) => {
    setAuthError(null);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
      await updateProfile(cred.user, { displayName: name.trim().slice(0, 80) });
      await sendEmailVerification(cred.user);
      return true;
    } catch (err) {
      setAuthError(mapAuthError(err));
      return false;
    }
  };

  const resendVerification = async () => {
    if (!auth.currentUser) return;
    setAuthError(null);
    try {
      await sendEmailVerification(auth.currentUser);
    } catch (err) {
      setAuthError(mapAuthError(err));
    }
  };

  const refreshAuthUser = async () => {
    if (!auth.currentUser) return;
    await auth.currentUser.reload();
    setUser({ ...auth.currentUser });
  };

  const logout = async () => {
    setAuthError(null);
    await signOut(auth);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        isAdmin,
        loading,
        authError,
        clearAuthError,
        loginWithGoogle,
        loginWithEmail,
        registerWithEmail,
        resendVerification,
        refreshAuthUser,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
