import { useTranslation } from "react-i18next";
import { AlertCircleIcon } from "lucide-react";

import { login } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function Welcome({ returnTo, reason }: { returnTo: string; reason?: "expired" }) {
  const { t } = useTranslation("oee");

  return (
    <Card className="text-center">
      <CardHeader>
        <CardTitle className="text-3xl">{t("auth.welcome")}</CardTitle>
        <CardDescription>{t("auth.signInHint")}</CardDescription>
      </CardHeader>
      {reason ? (
        <CardContent>
          <Alert variant="destructive" className="text-left">
            <AlertCircleIcon />
            <AlertDescription>{t("auth.sessionExpired")}</AlertDescription>
          </Alert>
        </CardContent>
      ) : null}
      <CardFooter className="justify-center">
        {/* Full-page navigation on purpose — /api/login answers with a cross-origin
            302 to the IdP, which a router navigation cannot follow. */}
        <Button size="lg" onClick={() => login(returnTo)}>
          {t("auth.signIn")}
        </Button>
      </CardFooter>
    </Card>
  );
}

export { Welcome };
